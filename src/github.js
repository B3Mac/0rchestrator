import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { OrchError } from './errors.js';
import {
  loadProject, CONFIG_FILE, STATE_DIR, LEDGER_FILE, isProtected,
} from './project.js';
import {
  loadTasks, getTask, normalizeId, saveTask, readinessFor, addAttempt, ACTIVE,
} from './tasks.js';
import {
  claimTask, unclaimTask, reopenTask, flagPlayer, banPlayer, unbanPlayer, releaseExpired, noteTask,
} from './ops.js';
import {
  statsFor, appendEvent, readLedger, canClaim, canVerify, playerKey,
} from './trust.js';
import { matchesScope } from './scope.js';
import { handoffPrompt, fence } from './prompt.js';
import {
  verifyCommandFor, ciCommandFor, runCheck, taskEnv, symbolProblems,
} from './verify.js';
import { diffNames, showFile, filesAt } from './git.js';
import { symbolsFor } from './scope.js';

// GitHub mode. Three kinds of jobs call into this file from the workflow:
//   trusted bookkeeping  (issue comments, merges, pushes, schedule): changes
//                        tasks/ and the ledger on the default branch
//   trusted scope check  (pull_request_target): reads the PR's file list from
//                        the API and NEVER checks out or runs the PR's code
//   sandboxed tests      (pull_request, read-only token): runs the task's
//                        checks against the PR, using task definitions from
//                        the base commit so a PR can't rewrite its own rules

export const INSTALL = 'npm install -g github:B3Mac/0rchestrator';
export const GUIDE_URL = 'https://github.com/B3Mac/0rchestrator/blob/main/docs/VOLUNTEER.md';
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const SCOPE_MARK = '<!-- 0rchestrator:scope -->';
const BOT_LOGIN = 'github-actions[bot]';
const BOT_ENV = {
  GIT_AUTHOR_NAME: BOT_LOGIN,
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: BOT_LOGIN,
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};
const COMMENT_CAP = 60_000;

export const HELP = [
  '**0rchestrator commands** (comment on a task issue)',
  '',
  '- `/claim`: take this task',
  '- `/unclaim [note]`: give it back, no penalty. The note (how close you got, a decomp.me link) goes in the next person\'s handoff',
  '- `/note <text>`: add to the task\'s notes for whoever works on it next (claimer or maintainers)',
  '- `/verified` on a PR: you ran its full check locally and it passes (maintainers and trusted players)',
  '- `/trust` or `/trust @user`: a trust score and record',
  '',
  'Maintainers only:',
  '',
  '- `/release`: free someone\'s claim, no penalty',
  '- `/reopen <note>`: send work back (costs the player trust)',
  '- `/flag @user <reason>`: mark a bad actor and pull back their work',
  '- `/ban @user <reason>` and `/unban @user`',
  '',
  `[Volunteer guide](${GUIDE_URL})`,
].join('\n');

// ---- small pure helpers ------------------------------------------------------

/** First task id found in any of the texts: "T-0003: ...", "t3-fix", "feat/T-12". */
export function taskIdFrom(...texts) {
  for (const t of texts) {
    const m = String(t ?? '').match(/(?:^|[^A-Za-z0-9])T-?(\d{1,6})(?![0-9])/i);
    if (m) return normalizeId(m[1]);
  }
  return null;
}

const COMMANDS = new Set(['claim', 'unclaim', 'release', 'reopen', 'flag', 'ban', 'unban', 'trust', 'help', 'note', 'verified']);

/** "/flag @mallory rewrote tests" → { name: 'flag', target: 'mallory', reason: 'rewrote tests' } */
export function parseCommand(body) {
  const line = String(body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = line.match(/^\/([a-z]+)(?:\s+(.*))?$/i);
  if (!m || !COMMANDS.has(m[1].toLowerCase())) return null;
  const rest = (m[2] ?? '').trim();
  const [first = '', ...more] = rest.split(/\s+/);
  const handle = first.startsWith('@') ? first.slice(1) : null;
  const target = handle && LOGIN.test(handle) ? handle : null;
  return { name: m[1].toLowerCase(), rest, target, reason: handle ? more.join(' ') : rest };
}

export function issueTitle(task) {
  return `${task.meta.id} · ${task.meta.title}`;
}

/** Inline code that stays inline code whatever the text holds (file names come from PRs). */
const code = (raw) => {
  const s = String(raw).replace(/[\r\n]+/g, ' ');
  if (!s.includes('`')) return `\`${s}\``;
  const run = Math.max(...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1;
  return `${'`'.repeat(run)} ${s} ${'`'.repeat(run)}`;
};
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const list = (xs) => xs.map(code).join(', ');

export function issueBody(project, task) {
  const m = task.meta;
  const cmd = verifyCommandFor(project, task);
  const bits = [`${m.size} ${m.type} task`];
  if (m.sensitive) bits.push('sensitive: needs a high trust score');
  if (m.reward) bits.push(`reward: ${m.reward} ${project.config.reward_unit}`);
  const waiting = m.depends_on.filter((d) => {
    try {
      return getTask(project, d).meta.status !== 'done';
    } catch {
      return true;
    }
  });
  return [
    `_${bits.join(' · ')}_`,
    '',
    task.body.trim().replace(/^(#{1,4}) /gm, '#$1 '),
    '',
    `**Scope**, the only files this task may change: ${m.scope.length ? list(m.scope) : '_none_'}`,
    '',
    `**Checks:** ${cmd ? code(cmd) : 'reviewed by a maintainer'}`,
    waiting.length ? `\n**Waiting on:** ${waiting.join(', ')}. You can claim it once those are done.` : '',
    '',
    '---',
    '',
    '### Volunteer your AI agent',
    '',
    '1. Comment `/claim` below. A bot confirms, or tells you what your trust level allows.',
    `2. Fork and clone this repo, install the CLI once (${code(INSTALL)}), then run ${code(`0rch prompt ${m.id}`)} and give the handoff to your AI.`,
    `3. Check your work with ${code(`0rch verify ${m.id}`)}.`,
    `4. Open a pull request titled ${code(`${m.id}: ${m.title}`)}.`,
    '',
    `Stuck? Comment \`/unclaim\`. · [Volunteer guide](${GUIDE_URL}) · \`/help\` for all commands`,
  ].join('\n');
}

function trustLine(project, name) {
  const s = statsFor(project, name);
  const bits = [`trust **${s.score}**`, s.tier, `${s.accepted} accepted`];
  if (s.reopened) bits.push(`${s.reopened} reopened`);
  if (s.scope_violations) bits.push(`${s.scope_violations} out of scope`);
  if (s.flags.length) bits.push(`${s.flags.length} flag${s.flags.length === 1 ? '' : 's'}`);
  if (s.earned) bits.push(`${s.earned} ${project.config.reward_unit} earned`);
  return `@${s.name}: ${bits.join(' · ')}${s.banned ? ' · **banned**' : ''}`;
}

export function claimMessage(project, task, login) {
  const m = task.meta;
  const s = statsFor(project, login);
  const cmd = verifyCommandFor(project, task);
  let handoff = handoffPrompt(project, task, { files: false });
  if (handoff.length > COMMENT_CAP - 3000) handoff = handoff.slice(0, COMMENT_CAP - 3000) + '\n\n_(cut off; run `0rch prompt` for the rest)_';
  const f = fence(handoff);
  return [
    `**Claimed for @${login}.** ${m.id} is yours for the next ${project.config.claim_timeout_hours} hours. Trust ${s.score} (${s.tier}).`,
    '',
    '1. Fork this repo and clone your fork. Already have one? Pull the latest default branch first.',
    `2. Install the CLI once: ${code(INSTALL)}`,
    `3. In your clone, ${code(`0rch prompt ${m.id}`)} prints the full handoff for your AI (Claude Code, Codex, ChatGPT…). A short version is below.`,
    `4. ${code(`0rch verify ${m.id}`)} checks your work${cmd ? `: scope plus ${code(cmd)}` : ''}.`,
    `5. Open a pull request titled ${code(`${m.id}: ${m.title}`)}.`,
    '',
    `Stuck? Comment \`/unclaim\` so someone else can take it. [Volunteer guide](${GUIDE_URL})`,
    '',
    '<details><summary>Handoff for your AI (without file contents)</summary>',
    '',
    `${f}markdown\n${handoff}\n${f}`,
    '',
    '</details>',
  ].join('\n');
}

/**
 * Decide whether a pull request is a valid answer to a task: claimed by its
 * author, author still allowed by the fences, and every changed file inside
 * the task's scope and outside the protected paths. Pure: no I/O.
 */
/** Files whose task scope limits them to certain functions; those need their contents checked. */
export function filesNeedingContents(project, id, files) {
  let task;
  try {
    task = getTask(project, id);
  } catch {
    return [];
  }
  return files.filter((f) => !isProtected(project, f) && symbolsFor(f, task.meta.scope));
}

/**
 * `contents` maps a file to { before, after } (text at the merge base and in
 * the PR); needed only for files scoped to single functions.
 */
export function checkPullRequest(project, { id, author, files, contents = new Map() }) {
  const reasons = [];
  const scope = { inside: [], outside: [], protected: [], passed: false };
  let task = null;
  try {
    task = getTask(project, id);
  } catch {
    reasons.push(`There is no task ${id} in this project.`);
    return { ok: false, id, author, task, reasons, scope };
  }
  const m = task.meta;
  if (m.status === 'done') reasons.push(`${id} is already done.`);
  else if (!ACTIVE.includes(m.status)) reasons.push(`${id} isn't claimed. Comment \`/claim\` on its issue first.`);
  else if (playerKey(m.claimed_by) !== playerKey(author)) reasons.push(`${id} is claimed by @${m.claimed_by}, not @${author}.`);
  const gate = canClaim(statsFor(project, author), task, project.config.trust);
  if (!gate.ok) reasons.push(gate.reason);

  for (const f of files) {
    if (isProtected(project, f)) scope.protected.push(f);
    else if (matchesScope(f, m.scope)) scope.inside.push(f);
    else scope.outside.push(f);
  }
  scope.symbol = symbolProblems(m.scope, scope.inside, (f) => contents.get(f));
  if (scope.protected.length) reasons.push(`Changes files no volunteer may touch: ${list(scope.protected)}.`);
  if (scope.outside.length) reasons.push(`Changes files outside the task's scope: ${list(scope.outside)}.`);
  for (const p of scope.symbol) reasons.push(`${code(p.file)} ${p.reason}.`);
  if (!files.length) reasons.push('Changes no files.');
  scope.passed = scope.inside.length > 0 && !scope.protected.length && !scope.outside.length && !scope.symbol.length;
  return { ok: reasons.length === 0, id, author, task, reasons, scope };
}

export function scopeReportMarkdown(report, { pr } = {}) {
  const t = report.task;
  const head = `### 0rchestrator scope check: ${report.ok ? 'passed' : 'failed'}`;
  const lines = [head, ''];
  lines.push(t ? `${pr ? `PR #${pr} by` : 'Work by'} @${report.author} for **${issueTitle(t)}**.` : `PR by @${report.author} for ${report.id}.`);
  lines.push('');
  if (report.scope.inside.length) lines.push(`- In scope: ${list(report.scope.inside)}`);
  for (const r of report.reasons) lines.push(`- **Problem:** ${r}`);
  lines.push('');
  lines.push(report.ok
    ? 'Tests run separately in the sandboxed **tests** check. A maintainer merges when both pass.'
    : 'Fix the problems above and push again. Only the files in the task\'s scope may change; tests, CI and task files are off-limits.');
  return lines.join('\n');
}

// ---- reading a project as it was at a commit ------------------------------------

/** Load config, tasks and ledger from a commit into a temp folder. */
export function loadProjectAtRef(root, ref) {
  const raw = showFile(root, ref, CONFIG_FILE);
  if (!raw) throw new OrchError(`No ${CONFIG_FILE} at ${String(ref).slice(0, 12)}.`, 'NO_PROJECT');
  let cfg;
  try {
    cfg = YAML.parse(raw.toString('utf8')) ?? {};
  } catch (err) {
    throw new OrchError(`${CONFIG_FILE} at ${String(ref).slice(0, 12)} is not valid YAML: ${err.message}`, 'BAD_CONFIG');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '0rch-base-'));
  const rels = [CONFIG_FILE, cfg.goal ?? 'GOAL.md', `${STATE_DIR}/${LEDGER_FILE}`, ...filesAt(root, ref, cfg.tasks_dir ?? 'tasks')];
  for (const rel of rels) {
    const buf = showFile(root, ref, rel);
    if (!buf) continue;
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return loadProject(tmp);
}

// ---- writing to the default branch ---------------------------------------------

function git(root, args, env) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env,
  });
}

function stageAndCommit(root, paths, message) {
  for (const p of paths) {
    try {
      git(root, ['add', '-A', '--', p]);
    } catch {
      // not on disk and not tracked: nothing to stage
    }
  }
  try {
    git(root, ['diff', '--cached', '--quiet']);
    return false;
  } catch {
    git(root, ['commit', '-q', '-m', message], BOT_ENV);
    return true;
  }
}

/**
 * Run `fn` against a fresh copy of the default branch and push what it
 * changed. If someone else pushed first, start over from their version, so
 * two people claiming the same task at once can't both win.
 */
export async function transact(ctx, message, fn) {
  const { root, branch } = ctx;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    git(root, ['fetch', '-q', 'origin', branch]);
    git(root, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    const fresh = loadProject(root);
    git(root, ['clean', '-fdq', '--', fresh.config.tasks_dir, STATE_DIR]);
    const result = await fn(loadProject(root));
    if (!stageAndCommit(root, [fresh.config.tasks_dir, path.join(STATE_DIR, LEDGER_FILE)], message)) return result;
    if (ctx.beforePush) await ctx.beforePush(attempt);
    try {
      git(root, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
      return result;
    } catch (err) {
      lastErr = err;
      ctx.log(`Push to ${branch} was rejected (someone else pushed first). Retrying.`);
    }
  }
  throw new Error(`Could not push to ${branch} after 5 tries: ${(lastErr?.stderr || lastErr?.message || '').toString().trim()}`);
}

/** A merged PR finishes its task and credits its author. */
export function recordMerge(project, id, { player, pr, by, now = new Date() }) {
  const task = getTask(project, id);
  if (task.meta.status === 'done') return { task, already: true };
  const prior = task.meta.claimed_by;
  if (prior && playerKey(prior) !== playerKey(player) && ACTIVE.includes(task.meta.status)) {
    appendEvent(project, { type: 'released', player: prior, task: id, note: `PR #${pr} by ${player} was merged instead` }, now);
  }
  task.meta.status = 'done';
  task.meta.claimed_by = player;
  task.meta.completed_at = now.toISOString();
  task.meta.base = null;
  task.meta.submitted_files = null;
  task.meta.pr = pr;
  saveTask(task);
  appendEvent(project, {
    type: 'accepted', player, task: id, size: task.meta.size, reward: task.meta.reward ?? 0, by: by ?? null, pr,
  }, now);
  return { task, already: false };
}

// ---- event handlers --------------------------------------------------------------

async function say(ctx, number, body) {
  try {
    await ctx.api.comment(number, body);
    ctx.posted.push({ number, body });
  } catch (err) {
    ctx.errors.push(`Could not comment on #${number}: ${err.message}`);
  }
}

async function taskIssues(ctx, project) {
  if (!ctx.issueCache) {
    const label = project.config.github?.label ?? '0rchestrator';
    const map = new Map();
    for (const issue of await ctx.api.listIssues(label)) {
      const id = taskIdFrom(issue.title);
      if (id && (!map.has(id) || issue.state === 'open')) map.set(id, issue);
    }
    ctx.issueCache = map;
  }
  return ctx.issueCache;
}

const HINTS = {
  FENCED: '\n\nNew players start on small tasks, and each accepted task raises your trust score. `/trust` shows yours.',
  NOT_READY: '\n\nIt unlocks when the tasks it depends on are done.',
};

async function onComment(ctx, payload) {
  const { issue, comment } = payload;
  if (payload.action !== 'created' || !issue || !comment) return;
  if (comment.user?.type === 'Bot') return;
  const cmd = parseCommand(comment.body);
  if (!cmd) return;
  const login = comment.user.login;
  const maintainer = MAINTAINERS.has(comment.author_association);
  const n = issue.number;
  const id = taskIdFrom(issue.title);
  const reply = (body) => say(ctx, n, body);
  ctx.summary.push(`@${login} commented \`/${cmd.name}\` on #${n}.`);

  const label = loadProject(ctx.root).config.github?.label ?? '0rchestrator';
  const labeled = (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === label);
  const needTask = async () => {
    if (issue.pull_request || !id || !labeled) {
      await reply(`@${login} use \`/${cmd.name}\` on a task's issue (their titles start with a task id like T-0003).`);
      return false;
    }
    return true;
  };
  const needMaintainer = async () => {
    if (!maintainer) {
      await reply(`@${login} only maintainers can use \`/${cmd.name}\`.`);
      return false;
    }
    return true;
  };
  const needTarget = async () => {
    if (!cmd.target) {
      await reply(`@${login} say who: \`/${cmd.name} @username${cmd.name === 'unban' ? '' : ' <reason>'}\`.`);
      return false;
    }
    return true;
  };

  try {
    switch (cmd.name) {
      case 'help':
        return reply(HELP);
      case 'trust':
        return reply(trustLine(loadProject(ctx.root), cmd.target || login));
      case 'claim': {
        if (!(await needTask())) return;
        await transact(ctx, `${id}: claimed by @${login}`, (p) => claimTask(p, id, login, { now: ctx.now }));
        const project = loadProject(ctx.root);
        await reply(claimMessage(project, getTask(project, id), login));
        try {
          await ctx.api.addAssignees(n, [login]);
        } catch (err) {
          ctx.log(`Could not assign @${login}: ${err.message}`);
        }
        return;
      }
      case 'unclaim': {
        if (!(await needTask())) return;
        const note = cmd.rest || null;
        await transact(ctx, `${id}: released by @${login}`, (p) => unclaimTask(p, id, { player: maintainer ? undefined : login, note, now: ctx.now }));
        return reply(`${id} is open again. Thanks for trying, @${login}.${note ? ' Your note is in the next person\'s handoff.' : ''} Anyone can \`/claim\` it now.`);
      }
      case 'note': {
        if (!(await needTask())) return;
        const task = getTask(loadProject(ctx.root), id);
        if (!maintainer && playerKey(task.meta.claimed_by) !== playerKey(login)) {
          return reply(`@${login} only the person who claimed ${id}, or a maintainer, can add notes.`);
        }
        if (!cmd.rest) return reply(`@${login} add the note after the command: \`/note 92% match, stuck on the loop: <decomp.me link>\`.`);
        await transact(ctx, `${id}: note from @${login}`, (p) => noteTask(p, id, { note: cmd.rest, by: login, now: ctx.now }));
        return reply(`Noted on ${id}. It's in the handoff for whoever works on it next.`);
      }
      case 'verified': {
        if (!issue.pull_request || !id) return reply(`@${login} use \`/verified\` on a task's pull request, after running its full check (\`0rch pr ${issue.number}\`).`);
        const project = loadProject(ctx.root);
        const author = issue.user?.login;
        if (author && playerKey(author) === playerKey(login)) return reply(`@${login} someone else has to verify your work.`);
        const stats = statsFor(project, login);
        if (!maintainer && !canVerify(stats, project.config.trust)) {
          const f = project.config.trust.fences.verify ?? { min_score: 70, min_accepted: 3 };
          return reply(`@${login} verifying needs trust ${f.min_score}+ and ${f.min_accepted} accepted tasks (you have ${stats.score} and ${stats.accepted}), or a maintainer.`);
        }
        await transact(ctx, `${id}: PR #${n} verified by @${login}`, (p) => appendEvent(p, { type: 'verified', player: login, task: id, pr: n, for: author ?? null, note: cmd.rest || null }, ctx.now));
        return reply(`**Verified** by @${login} (trust ${stats.score}, ${stats.tier}): the full check for ${id} passes on their machine.${cmd.rest ? ` Note: ${cmd.rest}` : ''}`);
      }
      case 'release': {
        if (!(await needMaintainer()) || !(await needTask())) return;
        const task = await transact(ctx, `${id}: released by maintainer @${login}`, (p) => unclaimTask(p, id, { now: ctx.now }));
        return reply(`Released @${task.meta.claimed_by ?? 'the'} claim. ${id} is open again; anyone can \`/claim\` it.`);
      }
      case 'reopen': {
        if (!(await needMaintainer()) || !(await needTask())) return;
        const note = cmd.rest || 'Reopened by a maintainer.';
        const before = getTask(loadProject(ctx.root), id).meta.claimed_by;
        await transact(ctx, `${id}: reopened by @${login}`, (p) => reopenTask(p, id, { note, by: login, now: ctx.now }));
        if (issue.state === 'closed') {
          try {
            await ctx.api.setIssueState(n, 'open');
          } catch (err) {
            ctx.errors.push(`Could not reopen #${n}: ${err.message}`);
          }
        }
        return reply(`Reopened ${id}${before ? ` (was @${before}'s)` : ''}: ${note}`);
      }
      case 'flag':
      case 'ban': {
        if (!(await needMaintainer()) || !(await needTarget())) return;
        if (!cmd.reason) return reply(`@${login} add a reason so the record shows why: \`/${cmd.name} @${cmd.target} <reason>\`.`);
        const fn = cmd.name === 'flag' ? flagPlayer : banPlayer;
        const out = await transact(ctx, `${cmd.name === 'flag' ? 'Flag' : 'Ban'} @${cmd.target}`, (p) => fn(p, cmd.target, { reason: cmd.reason, by: login, now: ctx.now }));
        const pulled = out.pulled.length ? ` Pulled back ${out.pulled.join(', ')}; ${out.pulled.length === 1 ? 'it is' : 'they are'} open again.` : '';
        return reply(`${cmd.name === 'flag' ? 'Flagged' : 'Banned'} @${cmd.target}: ${cmd.reason}. Trust is now ${out.stats.score} (${out.stats.tier}).${pulled}`);
      }
      case 'unban': {
        if (!(await needMaintainer()) || !(await needTarget())) return;
        const s = await transact(ctx, `Unban @${cmd.target}`, (p) => unbanPlayer(p, cmd.target, { reason: cmd.reason || null, by: login, now: ctx.now }));
        return reply(`Unbanned @${cmd.target}. Trust ${s.score} (${s.tier}).`);
      }
      default:
    }
  } catch (err) {
    if (err instanceof OrchError) return reply(`@${login} ${err.message}${HINTS[err.code] ?? ''}`);
    throw err;
  }
}

async function upsertScopeComment(ctx, number, md) {
  const body = `${SCOPE_MARK}\n${md}`;
  try {
    const mine = (await ctx.api.listComments(number)).find((c) => c.user?.login === BOT_LOGIN && c.body?.includes(SCOPE_MARK));
    if (mine) await ctx.api.editComment(mine.id, body);
    else await ctx.api.comment(number, body);
    ctx.posted.push({ number, body });
  } catch (err) {
    ctx.errors.push(`Could not comment on PR #${number}: ${err.message}`);
  }
}

/** Trusted scope check. Never checks out or runs the PR: only its file list from the API. */
async function onPullRequest(ctx, payload) {
  const pr = payload.pull_request;
  const id = taskIdFrom(pr.title, pr.head?.ref);
  if (!id) {
    ctx.summary.push('Not a 0rchestrator task PR (no task id like T-0003 in its title or branch), so nothing to check.');
    return;
  }
  if (pr.base?.ref && pr.base.ref !== ctx.branch) {
    ctx.summary.push(`PR #${pr.number} targets ${pr.base.ref}, not ${ctx.branch}; only PRs into ${ctx.branch} count.`);
    return;
  }
  const author = pr.user.login;
  const files = await ctx.api.prFiles(pr.number);
  const project = loadProject(ctx.root);
  // Function-scoped files: compare their text at the merge base and in the PR (read via the API, never run).
  const contents = new Map();
  const needing = filesNeedingContents(project, id, files);
  if (needing.length) {
    const mergeBase = await ctx.api.mergeBase(pr.base.sha, pr.head.sha);
    for (const f of needing) contents.set(f, { before: await ctx.api.fileAt(f, mergeBase), after: await ctx.api.fileAt(f, pr.head.sha) });
  }
  const report = checkPullRequest(project, { id, author, files, contents });
  // GitHub lists at most 3,000 files per PR; anything it can't list can't be checked.
  if (Number(pr.changed_files) > files.length) {
    report.ok = false;
    report.scope.passed = false;
    report.reasons.push(`Changes ${pr.changed_files} files, more than can be checked. Split it into smaller PRs.`);
  }
  const bad = [...report.scope.protected, ...report.scope.outside, ...(report.scope.symbol ?? []).map((p) => p.file)];
  const ownClaim = report.task && ACTIVE.includes(report.task.meta.status) && playerKey(report.task.meta.claimed_by) === playerKey(author);
  if (bad.length && ownClaim) {
    // Counts once per pull request, however many times it's pushed to.
    await transact(ctx, `${id}: out-of-scope PR #${pr.number} by @${author}`, (p) => {
      if (readLedger(p).some((e) => e.type === 'scope_violation' && e.pr === pr.number)) return;
      appendEvent(p, { type: 'scope_violation', player: author, task: id, files: bad, pr: pr.number }, ctx.now);
    });
  }
  const md = scopeReportMarkdown(report, { pr: pr.number });
  ctx.summary.push(md);
  await upsertScopeComment(ctx, pr.number, md);
  if (!report.ok) ctx.exitCode = 1;
}

async function onMerged(ctx, payload) {
  const pr = payload.pull_request;
  const id = taskIdFrom(pr.title, pr.head?.ref);
  if (!id) return;
  if (pr.base?.ref && pr.base.ref !== ctx.branch) return;
  const author = pr.user.login;
  const by = payload.sender?.login ?? pr.merged_by?.login ?? null;
  let res;
  try {
    res = await transact(ctx, `${id}: accepted (PR #${pr.number} by @${author})`, (p) => recordMerge(p, id, { player: author, pr: pr.number, by, now: ctx.now }));
  } catch (err) {
    if (err instanceof OrchError) {
      ctx.summary.push(`Merged PR #${pr.number} mentions ${id}, but: ${err.message}`);
      return;
    }
    throw err;
  }
  if (res.already) {
    ctx.summary.push(`${id} was already done.`);
    return;
  }
  const project = loadProject(ctx.root);
  const s = statsFor(project, author);
  const task = getTask(project, id);
  const tasks = loadTasks(project);
  const ready = readinessFor(project, tasks);
  const unlocked = tasks.filter((t) => t.meta.depends_on.includes(id) && ready.get(t.meta.id).ready).map((t) => t.meta.id);
  const reward = task.meta.reward ? ` and earned ${task.meta.reward} ${project.config.reward_unit}` : '';
  await say(ctx, pr.number, `**Accepted ${id}.** Thanks, @${author}! Your trust score is now ${s.score} (${s.tier})${reward}.${unlocked.length ? ` This unlocked ${unlocked.join(', ')}.` : ''}`);
  const issue = (await taskIssues(ctx, project)).get(id);
  if (issue && issue.state === 'open') {
    await say(ctx, issue.number, `Done in #${pr.number} by @${author}.`);
    try {
      await ctx.api.setIssueState(issue.number, 'closed');
    } catch (err) {
      ctx.errors.push(`Could not close #${issue.number}: ${err.message}`);
    }
  }
  ctx.summary.push(`Accepted ${id} for @${author} (PR #${pr.number}).`);
}

async function onSchedule(ctx) {
  const open = await ctx.api.listOpenPulls();
  const tasks = new Map(loadTasks(loadProject(ctx.root)).map((t) => [t.meta.id, t]));
  // A claim stays alive while its claimer has a PR open for it (anyone else's PR doesn't count).
  const keep = new Set(open.map((p) => {
    const id = taskIdFrom(p.title, p.head?.ref);
    const t = id && tasks.get(id);
    return t && playerKey(t.meta.claimed_by) === playerKey(p.user?.login) ? id : null;
  }).filter(Boolean));
  const released = await transact(ctx, 'Release expired claims', (p) => releaseExpired(p, { now: ctx.now, keep }));
  if (!released.length) {
    ctx.summary.push('No expired claims.');
    return;
  }
  const project = loadProject(ctx.root);
  const issues = await taskIssues(ctx, project);
  for (const id of released) {
    const issue = issues.get(id);
    if (issue) await say(ctx, issue.number, `The claim on ${id} expired after ${project.config.claim_timeout_hours} hours with no pull request, so it's open again. Comment \`/claim\` to take it.`);
  }
  ctx.summary.push(`Released expired claims: ${released.join(', ')}.`);
}

/** One issue per task: create missing ones, close finished ones, reopen reopened ones. */
export async function syncIssues(ctx) {
  const project = loadProject(ctx.root);
  const label = project.config.github?.label ?? '0rchestrator';
  await ctx.api.ensureLabel(label, 'ff9f43', 'Open for volunteer AI agents (0rchestrator)');
  const issues = await taskIssues(ctx, project);
  const done = { created: [], closed: [], reopened: [] };
  for (const task of loadTasks(project)) {
    const issue = issues.get(task.meta.id);
    const finished = task.meta.status === 'done';
    if (!issue && !finished) {
      const made = await ctx.api.createIssue({ title: issueTitle(task), body: issueBody(project, task), labels: [label] });
      issues.set(task.meta.id, made);
      done.created.push(`${task.meta.id} → #${made.number}`);
    } else if (issue && issue.state === 'open' && finished) {
      await ctx.api.setIssueState(issue.number, 'closed');
      done.closed.push(`#${issue.number}`);
    } else if (issue && issue.state === 'closed' && !finished) {
      await ctx.api.setIssueState(issue.number, 'open');
      done.reopened.push(`#${issue.number}`);
    }
  }
  const parts = Object.entries(done).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.join(', ')}`);
  ctx.summary.push(parts.length ? `Issues ${parts.join('; ')}.` : 'Issues already match the tasks.');
  return done;
}

export function defaultBranch(payload, env = process.env) {
  return payload?.repository?.default_branch || env.GITHUB_REF_NAME || 'main';
}

/** Entry point for the workflow's trusted jobs. */
export async function handleEvent({
  root, eventName, payload, api, now = new Date(), env = process.env, beforePush = null, log = () => {},
}) {
  const ctx = {
    root, api, now, beforePush, log, branch: defaultBranch(payload, env), summary: [], errors: [], posted: [], exitCode: 0,
  };
  switch (eventName) {
    case 'issue_comment':
      await onComment(ctx, payload);
      break;
    case 'pull_request_target':
      if (payload.action === 'closed') {
        if (payload.pull_request?.merged) await onMerged(ctx, payload);
      } else {
        await onPullRequest(ctx, payload);
      }
      break;
    case 'push':
      await syncIssues(ctx);
      break;
    case 'schedule':
    case 'workflow_dispatch':
      await onSchedule(ctx);
      await syncIssues(ctx);
      break;
    default:
      ctx.summary.push(`0rchestrator has nothing to do for "${eventName}" events.`);
  }
  if (ctx.errors.length) ctx.exitCode = 1;
  return { exitCode: ctx.exitCode, summary: [...ctx.summary, ...ctx.errors.map((e) => `**Error:** ${e}`)].join('\n\n'), posted: ctx.posted, errors: ctx.errors };
}

/**
 * The sandboxed tests job. Runs the PR's code, but takes the task, its scope
 * and its check command from the base commit.
 */
export function checkPrTests({ root, base, head = 'HEAD', title, branch, author }) {
  const id = taskIdFrom(title, branch);
  if (!id) return { exitCode: 0, skipped: true, summary: 'Not a 0rchestrator task PR (no task id like T-0003 in its title or branch), so nothing to test.' };
  if (!base) throw new OrchError('Need the base commit (--base) to compare against.', 'USAGE');
  const project = loadProjectAtRef(root, base);
  const files = diffNames(root, `${base}...${head}`);
  const mergeBase = execFileSync('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8' }).trim();
  const text = (ref, f) => showFile(root, ref, f)?.toString('utf8') ?? null;
  const contents = new Map(filesNeedingContents(project, id, files).map((f) => [f, { before: text(mergeBase, f), after: text(head, f) }]));
  const report = checkPullRequest(project, { id, author: author ?? 'unknown', files, contents });
  const lines = [`### 0rchestrator tests: ${id}`, ''];
  let passed = false;
  if (!report.task) {
    lines.push(`- **Problem:** ${report.reasons[0]}`);
  } else if (!report.scope.passed) {
    lines.push('Tests were not run: this PR changes things outside its task\'s scope (see the **scope** check).');
    for (const f of [...report.scope.protected, ...report.scope.outside]) lines.push(`- ${code(f)}`);
    for (const p of report.scope.symbol ?? []) lines.push(`- ${code(p.file)} ${p.reason}`);
  } else {
    const timeout = project.config.verify_timeout_seconds;
    let run = null;
    if (project.config.setup) {
      const s = runCheck(project.config.setup, { cwd: root, timeoutSeconds: timeout });
      lines.push(`- Setup ${code(project.config.setup)}: ${s.passed ? 'ok' : `**failed** (exit ${s.exit_code})`}`);
      if (!s.passed) run = s;
    }
    if (!run) {
      const ci = ciCommandFor(project, report.task);
      const cmd = ci.cmd;
      if (ci.localOnly) {
        lines.push(`- The full check (${code(verifyCommandFor(project, report.task) ?? 'none set')}) needs files CI doesn't have, like the original game. A maintainer or trusted volunteer with them runs \`0rch pr <number>\` and comments \`/verified\`.`);
      }
      if (!cmd) {
        if (!ci.localOnly) lines.push('- No automatic check for this task type. A maintainer reviews it.');
        passed = true;
      } else {
        run = runCheck(cmd, { cwd: root, timeoutSeconds: timeout, env: taskEnv(report.task) });
        lines.push(`- Checks ${code(cmd)}: ${run.passed ? 'passed' : run.timed_out ? '**timed out**' : `**failed** (exit ${run.exit_code})`}`);
        passed = run.passed;
      }
    }
    if (run && !run.passed && run.output) {
      const f = fence(run.output);
      lines.push('', '<details><summary>Output</summary>', '', `${f}\n${run.output.trimEnd()}\n${f}`, '', '</details>');
    }
  }
  const claimNotes = report.reasons.filter((r) => !/files|Changes no/.test(r));
  if (report.task && claimNotes.length) lines.push('', ...claimNotes.map((r) => `- Note: ${r}`));
  lines.push('', passed ? 'Result: **passed**' : 'Result: **failed**');
  return { exitCode: passed ? 0 : 1, passed, report, summary: lines.join('\n') };
}
