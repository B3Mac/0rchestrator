import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OrchError } from './errors.js';
import { STATE_DIR } from './project.js';
import {
  loadTasks, getTask, saveTask, readinessFor, addNote, addAttempt, clearClaim, ACTIVE,
} from './tasks.js';
import {
  appendEvent, playerStats, statsFor, canClaim, playerKey,
} from './trust.js';
import { verifyTask, symbolProblems } from './verify.js';
import {
  headSha, gitUserName, isGitRepo, commitPaths, changedFiles, fetchRef, diffNames, showFile,
} from './git.js';
import { matchesScope } from './scope.js';
import { bookkeepingPaths } from './project.js';

/**
 * In GitHub mode the default branch is the source of truth: claims happen with
 * /claim on the task's issue and work arrives as a pull request. Local claim
 * commands would only change the volunteer's own copy, so they explain that.
 */
export function guardGithubMode(project, action) {
  if (project.config.workflow !== 'github') return;
  const tasks = loadTasks(project);
  const readiness = readinessFor(project, tasks);
  const ready = tasks.filter((t) => readiness.get(t.meta.id).ready).map((t) => t.meta.id);
  const where = action === 'unclaim' ? 'comment `/unclaim` on the task\'s GitHub issue' : 'comment `/claim` on the task\'s GitHub issue';
  throw new OrchError(
    `This project uses GitHub mode, so ${action === 'unclaim' ? 'give tasks back' : 'claims happen'} on GitHub: ${where}.${action !== 'unclaim' && ready.length ? ` Ready now: ${ready.join(', ')}.` : ''}`,
    'GITHUB_MODE',
  );
}

/** What to tell a GitHub-mode volunteer whose work passes verify. */
export function pullRequestHint(task) {
  const title = `${task.meta.id}: ${task.meta.title}`;
  return `Looks good. Push your branch and open a pull request titled "${title}":\n  gh pr create --title ${JSON.stringify(title)}`;
}

/** Who is acting: --as, then $ORCH_VOLUNTEER, then git user.name, then the OS user. */
export function resolvePlayer(project, given) {
  const name = given || process.env.ORCH_VOLUNTEER || gitUserName(project.root) || os.userInfo().username;
  if (!String(name).trim()) throw new OrchError('Could not tell who you are. Pass --as <name>.', 'NO_PLAYER');
  return String(name).trim();
}

function samePlayer(a, b) {
  return playerKey(a) === playerKey(b);
}

/** Return claims older than the timeout to the pool (except task ids in `keep`, e.g. ones with an open PR). */
export function releaseExpired(project, { now = new Date(), keep = new Set() } = {}) {
  const hours = project.config.claim_timeout_hours;
  const released = [];
  for (const task of loadTasks(project)) {
    if (task.meta.status !== 'claimed' || !task.meta.claimed_at || keep.has(task.meta.id)) continue;
    const age = (now - new Date(task.meta.claimed_at)) / 36e5;
    if (age < hours) continue;
    const player = task.meta.claimed_by;
    addNote(task, `Claim by ${player} expired after ${hours}h and was released.`, '0rchestrator', now);
    task.meta.status = 'open';
    clearClaim(task.meta);
    saveTask(task);
    appendEvent(project, { type: 'expired', player, task: task.meta.id }, now);
    released.push(task.meta.id);
  }
  return released;
}

/** Ready tasks this player is allowed to take, in id order. */
export function claimableTasks(project, player) {
  const tasks = loadTasks(project);
  const ready = readinessFor(project, tasks);
  const stats = statsFor(project, player);
  return tasks.filter((t) => ready.get(t.meta.id).ready && canClaim(stats, t, project.config.trust).ok);
}

export function claimTask(project, id, player, { now = new Date(), force = false } = {}) {
  const tasks = loadTasks(project);
  const task = getTask(project, id, tasks);
  if (task.meta.status !== 'open') {
    const who = task.meta.claimed_by ? ` by ${task.meta.claimed_by}` : '';
    throw new OrchError(`${task.meta.id} is ${task.meta.status}${who}, so it can't be claimed.`, 'NOT_OPEN');
  }
  const ready = readinessFor(project, tasks).get(task.meta.id);
  if (!ready.ready && !force) {
    throw new OrchError(`${task.meta.id} isn't ready: ${ready.reasons.join('; ')}.`, 'NOT_READY');
  }
  const gate = canClaim(statsFor(project, player), task, project.config.trust);
  if (!gate.ok) throw new OrchError(`Fenced: ${gate.reason}`, 'FENCED');

  task.meta.status = 'claimed';
  task.meta.claimed_by = player;
  task.meta.claimed_at = now.toISOString();
  task.meta.base = isGitRepo(project.root) ? headSha(project.root) : null;
  task.meta.submitted_at = null;
  saveTask(task);
  appendEvent(project, { type: 'claimed', player, task: task.meta.id }, now);
  return task;
}

/** Claim the next task this player can take. Returns null when nothing is available. */
export function play(project, player, { now = new Date() } = {}) {
  releaseExpired(project, { now });
  const [next] = claimableTasks(project, player);
  return next ? claimTask(project, next.meta.id, player, { now }) : null;
}

export function unclaimTask(project, id, { player, note, now = new Date() } = {}) {
  const task = getTask(project, id);
  if (task.meta.status !== 'claimed') throw new OrchError(`${task.meta.id} is ${task.meta.status}, not claimed.`, 'NOT_CLAIMED');
  if (player && !samePlayer(player, task.meta.claimed_by)) {
    throw new OrchError(`${task.meta.id} is claimed by ${task.meta.claimed_by}, not ${player}.`, 'NOT_YOURS');
  }
  const was = task.meta.claimed_by;
  task.meta.status = 'open';
  clearClaim(task.meta);
  if (note) addAttempt(task, note, was, now);
  saveTask(task);
  appendEvent(project, { type: 'released', player: was, task: task.meta.id }, now);
  return task;
}

/**
 * Leave notes for the next person: how close you got, a decomp.me link, what
 * didn't work. They're in every future handoff, so nobody repeats a dead end.
 */
export function noteTask(project, id, { note, by, now = new Date() } = {}) {
  if (!note || !String(note).trim()) throw new OrchError('Say what to note, e.g. "92% match, stuck on the loop: https://decomp.me/scratch/abc".', 'USAGE');
  const task = getTask(project, id);
  addAttempt(task, note, by, now);
  saveTask(task);
  return task;
}

/** sha256 of a file's current bytes, or "deleted". */
export function fileHash(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return 'deleted';
  return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}

/**
 * When several tasks share one working tree, another task's submitted (not
 * yet accepted) work shows up as uncommitted changes. Those files are not this
 * task's doing, but only while they are exactly as that task submitted them:
 * touch one and it counts against you.
 */
function othersSubmittedWork(project, task) {
  const pinned = new Map();
  for (const t of loadTasks(project)) {
    if (t.meta.id === task.meta.id || t.meta.status !== 'review') continue;
    for (const [rel, hash] of Object.entries(t.meta.submitted_files ?? {})) pinned.set(rel, hash);
  }
  return (rel) => pinned.has(rel) && pinned.get(rel) === fileHash(project.root, rel);
}

/** Submitted files whose bytes no longer match what was submitted. */
function tamperedSince(project, task) {
  return Object.entries(task.meta.submitted_files ?? {})
    .filter(([rel, hash]) => fileHash(project.root, rel) !== hash)
    .map(([rel]) => rel);
}

/**
 * Run a task's checks. Claimed: the way submit will (others' pending work is
 * not held against it). In review: exactly the files that were submitted,
 * and fail if any of them changed since.
 */
export function checkTask(project, task) {
  if (task.meta.status === 'review' && task.meta.submitted_files) {
    const res = verifyTask(project, task, { changed: Object.keys(task.meta.submitted_files) });
    const tampered = tamperedSince(project, task);
    if (tampered.length) {
      res.scope.tampered = tampered;
      res.scope.passed = false;
      res.passed = false;
    }
    return res;
  }
  return verifyTask(project, task, { exempt: othersSubmittedWork(project, task) });
}

/**
 * Verify and hand in a claimed task. Passing work moves to review.
 * A scope violation or failing check costs trust score and leaves the task claimed.
 */
export function submitTask(project, id, { player, now = new Date(), changed = null, symbols = true } = {}) {
  const task = getTask(project, id);
  if (task.meta.status !== 'claimed') throw new OrchError(`${task.meta.id} is ${task.meta.status}; only claimed tasks can be submitted.`, 'NOT_CLAIMED');
  if (player && !samePlayer(player, task.meta.claimed_by)) {
    throw new OrchError(`${task.meta.id} is claimed by ${task.meta.claimed_by}, not ${player}.`, 'NOT_YOURS');
  }
  const result = verifyTask(project, task, { changed, symbols, exempt: changed ? () => false : othersSubmittedWork(project, task) });
  const who = task.meta.claimed_by;
  if (result.scope.checked && result.scope.outside.length) {
    appendEvent(project, { type: 'scope_violation', player: who, task: task.meta.id, files: result.scope.outside }, now);
  } else if (!result.passed) {
    appendEvent(project, { type: 'failed_submit', player: who, task: task.meta.id }, now);
  } else {
    task.meta.status = 'review';
    task.meta.submitted_at = now.toISOString();
    task.meta.submitted_files = Object.fromEntries((result.scope.inside ?? []).map((rel) => [rel, fileHash(project.root, rel)]));
    saveTask(task);
    appendEvent(project, { type: 'submitted', player: who, task: task.meta.id }, now);
  }
  return { task, result };
}

/** Approve reviewed work: credit the player and (in a git repo) commit the task's files. */
export function acceptTask(project, id, { by, now = new Date(), commit = true } = {}) {
  const task = getTask(project, id);
  if (task.meta.status !== 'review') throw new OrchError(`${task.meta.id} is ${task.meta.status}; only tasks in review can be accepted.`, 'NOT_IN_REVIEW');
  const tampered = tamperedSince(project, task);
  if (tampered.length) {
    throw new OrchError(
      `Not accepted: ${tampered.join(', ')} changed after ${task.meta.id} was submitted. Reopen it, or restore the files and review again.`,
      'TAMPERED',
    );
  }
  const submitted = Object.keys(task.meta.submitted_files ?? {});
  const player = task.meta.claimed_by;
  task.meta.status = 'done';
  task.meta.completed_at = now.toISOString();
  task.meta.base = null;
  task.meta.submitted_files = null;
  saveTask(task);
  appendEvent(project, {
    type: 'accepted', player, task: task.meta.id, size: task.meta.size, reward: task.meta.reward ?? 0, by: by ?? null,
  }, now);

  let committed = null;
  let commitError = null;
  if (commit && isGitRepo(project.root)) {
    // Commit exactly what was submitted (falls back to in-scope changes for older task files).
    const scoped = submitted.length
      ? submitted
      : changedFiles(project.root, null).filter((f) => matchesScope(f, task.meta.scope));
    try {
      committed = commitPaths(
        project.root,
        [...scoped, project.config.tasks_dir, path.join(STATE_DIR, 'ledger.jsonl')],
        `${task.meta.id}: ${task.meta.title}\n\nAccepted via 0rchestrator. Work by ${player}.`,
      );
    } catch (err) {
      commitError = (err.stderr || err.message || '').toString().trim();
    }
  }
  return { task, committed, commitError };
}

/** Send work back. Costs the player trust unless penalty is false. */
export function reopenTask(project, id, { note, by, penalty = true, now = new Date() } = {}) {
  const task = getTask(project, id);
  if (!ACTIVE.includes(task.meta.status) && task.meta.status !== 'done') {
    throw new OrchError(`${task.meta.id} is ${task.meta.status}; nothing to reopen.`, 'NOT_ACTIVE');
  }
  const player = task.meta.claimed_by;
  addNote(task, note || 'Reopened.', by, now);
  task.meta.status = 'open';
  task.meta.completed_at = null;
  clearClaim(task.meta);
  saveTask(task);
  if (player) appendEvent(project, { type: 'reopened', player, task: task.meta.id, note: note ?? null, by: by ?? null, penalty }, now);
  return task;
}

function pullBackWork(project, player, reason, by, now) {
  const pulled = [];
  for (const t of loadTasks(project)) {
    if (ACTIVE.includes(t.meta.status) && samePlayer(t.meta.claimed_by, player)) {
      reopenTask(project, t.meta.id, { note: `Pulled back: ${reason}`, by, penalty: false, now });
      pulled.push(t.meta.id);
    }
  }
  return pulled;
}

/** A maintainer marks a player as a suspected bad actor. Their in-progress work is pulled back. */
export function flagPlayer(project, player, { reason, by, now = new Date() } = {}) {
  if (!reason) throw new OrchError('Flagging someone needs a --reason, so the record shows why.', 'NO_REASON');
  appendEvent(project, { type: 'flagged', player, reason, by: by ?? null }, now);
  const pulled = pullBackWork(project, player, `${player} was flagged (${reason})`, by, now);
  return { stats: statsFor(project, player), pulled };
}

export function banPlayer(project, player, { reason, by, now = new Date() } = {}) {
  if (!reason) throw new OrchError('Banning someone needs a --reason, so the record shows why.', 'NO_REASON');
  appendEvent(project, { type: 'banned', player, reason, by: by ?? null }, now);
  const pulled = pullBackWork(project, player, `${player} was banned (${reason})`, by, now);
  return { stats: statsFor(project, player), pulled };
}

export function unbanPlayer(project, player, { reason, by, now = new Date() } = {}) {
  const stats = statsFor(project, player);
  if (!stats.banned) throw new OrchError(`${player} is not banned.`, 'NOT_BANNED');
  appendEvent(project, { type: 'unbanned', player, reason: reason ?? null, by: by ?? null }, now);
  return statsFor(project, player);
}

export function listPlayers(project) {
  return [...playerStats(project).values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Bringing outside work in: a volunteer's fork/branch, or a returned packet.

/** Write a set of incoming files, remembering what was there so it can be undone. */
export function applyFiles(root, changes) {
  const backup = changes.map(({ rel }) => {
    const full = path.join(root, rel);
    return { rel, before: fs.existsSync(full) ? fs.readFileSync(full) : null };
  });
  for (const { rel, content } of changes) {
    const full = path.join(root, rel);
    if (content === null) fs.rmSync(full, { force: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return backup;
}

export function revertFiles(root, backup) {
  for (const { rel, before } of backup) {
    const full = path.join(root, rel);
    if (before === null) fs.rmSync(full, { force: true });
    else fs.writeFileSync(full, before);
  }
}

/**
 * Three-way merge one file: `ours` (what's on disk now), `base` (what the
 * volunteer started from) and `theirs` (what they sent). Returns the merged
 * bytes, or null on a conflict. Lets several people finish different
 * functions of one file without overwriting each other.
 */
export function mergeFile(ours, base, theirs) {
  if (base === undefined) return theirs;
  const eq = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
  if (eq(ours, base)) return theirs;
  if (eq(ours, theirs) || eq(base, theirs)) return ours;
  if (ours === null || base === null || theirs === null) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0rch-merge-'));
  const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
  fs.writeFileSync(o, ours);
  fs.writeFileSync(b, base);
  fs.writeFileSync(t, theirs);
  try {
    return execFileSync('git', ['merge-file', '-p', '-q', o, b, t], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Shared path for outside work (a fork or a returned packet). `changes` is
 * [{ rel, content, base }]: the file as sent, and as it was when the volunteer
 * started (undefined if unknown). Checks scope, merges onto the current
 * files, runs the checks, and puts everything back if they fail.
 */
export function intake(project, task, changes, { now = new Date() } = {}) {
  const ignored = bookkeepingPaths(project);
  const relevant = changes.filter((c) => !ignored.some((d) => c.rel.startsWith(d)));
  const outside = relevant.filter((c) => !matchesScope(c.rel, task.meta.scope)).map((c) => c.rel);
  const disk = (rel) => {
    const full = path.join(project.root, rel);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  };
  const text = (b) => (b === null || b === undefined ? b : b.toString('utf8'));
  const byRel = new Map(relevant.map((c) => [c.rel, c]));
  const symbol = symbolProblems(task.meta.scope, relevant.map((c) => c.rel).filter((r) => matchesScope(r, task.meta.scope)), (rel) => {
    const c = byRel.get(rel);
    return { before: text(c.base === undefined ? disk(rel) : c.base), after: text(c.content) };
  });
  const player = task.meta.claimed_by;
  const fail = (scope, reason) => ({
    task,
    applied: false,
    result: { task: task.meta.id, passed: false, scope: { checked: true, changed: relevant.map((c) => c.rel), inside: [], outside: [], symbol: [], empty: false, passed: false, ...scope }, command: { ran: false, passed: false, reason } },
  });

  if (outside.length || symbol.length) {
    appendEvent(project, { type: 'scope_violation', player, task: task.meta.id, files: [...outside, ...symbol.map((p) => p.file)] }, now);
    return fail({ outside, symbol }, 'Not run: the work changed things outside its scope.');
  }
  if (!relevant.length) {
    appendEvent(project, { type: 'failed_submit', player, task: task.meta.id }, now);
    return fail({ empty: true }, 'Not run: nothing changed.');
  }
  if (isGitRepo(project.root)) {
    const dirty = changedFiles(project.root, null).filter((f) => byRel.has(f));
    if (dirty.length) {
      throw new OrchError(`You have uncommitted changes to ${dirty.join(', ')}. Commit or stash them first.`, 'DIRTY');
    }
  }
  const merged = relevant.map((c) => ({ rel: c.rel, content: mergeFile(disk(c.rel), c.base, c.content) }));
  const conflicts = merged.filter((m, i) => m.content === null && relevant[i].content !== null).map((m) => m.rel);
  if (conflicts.length) {
    // Not the volunteer's fault: the file moved on since they started. No penalty.
    return fail({ conflicts }, `Not applied: ${conflicts.join(', ')} changed since this work started and the changes overlap. The volunteer should update their copy and send it again.`);
  }

  const backup = applyFiles(project.root, merged);
  const out = submitTask(project, task.meta.id, { now, changed: merged.map((c) => c.rel), symbols: false });
  if (!out.result.passed) revertFiles(project.root, backup);
  return { ...out, applied: out.result.passed };
}

function ownerFromUrl(url) {
  const m = String(url).match(/github\.com[:/]+([^/]+)\/[^/]+?(?:\.git)?\/?$/i);
  return m ? m[1] : null;
}

/**
 * Pull a volunteer's fork or branch in for one task. The GitHub owner of the
 * fork is the player unless --as says otherwise.
 */
export function collectFork(project, id, url, { ref = 'HEAD', player, now = new Date() } = {}) {
  if (!isGitRepo(project.root)) throw new OrchError('Collecting forks needs the project to be a git repository.', 'NO_GIT');
  const who = player || ownerFromUrl(url);
  if (!who) throw new OrchError(`Can't tell whose fork ${url} is. Pass --as <name>.`, 'NO_PLAYER');

  let task = getTask(project, id);
  if (task.meta.status === 'open') task = claimTask(project, id, who, { now });
  else if (task.meta.status !== 'claimed' || !samePlayer(task.meta.claimed_by, who)) {
    throw new OrchError(`${task.meta.id} is ${task.meta.status}${task.meta.claimed_by ? ` by ${task.meta.claimed_by}` : ''}, not open or claimed by ${who}.`, 'NOT_YOURS');
  }

  let fetched;
  try {
    fetched = fetchRef(project.root, url, ref);
  } catch (err) {
    throw new OrchError(err.message, 'FETCH_FAILED');
  }
  const base = task.meta.base || headSha(project.root);
  // Three-dot: only what the fork changed since it split off, not what main did since.
  const names = diffNames(project.root, `${base}...${fetched}`);
  const mergeBase = execFileSync('git', ['merge-base', base, fetched], { cwd: project.root, encoding: 'utf8' }).trim();
  const changes = names
    .map((rel) => ({ rel, content: showFile(project.root, fetched, rel), base: showFile(project.root, mergeBase, rel) }))
    // A fork that is behind may "change" files to what main already has: not a real change.
    .filter(({ rel, content }) => {
      const full = path.join(project.root, rel);
      const current = fs.existsSync(full) ? fs.readFileSync(full) : null;
      return !(content === null ? current === null : current !== null && current.equals(content));
    });
  return { ...intake(project, task, changes, { now }), commit: fetched, player: who };
}
