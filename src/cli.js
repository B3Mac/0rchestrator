#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.js';
import { loadProject } from './project.js';
import {
  loadTasks, getTask, computeReadiness, createTask,
} from './tasks.js';
import { describeVerify } from './verify.js';
import { handoffPrompt, conductorPrompt, reviewPrompt } from './prompt.js';
import {
  resolvePlayer, claimTask, unclaimTask, play, claimableTasks, submitTask, acceptTask, reopenTask,
  releaseExpired, flagPlayer, banPlayer, unbanPlayer, listPlayers, collectFork, checkTask,
  guardGithubMode, pullRequestHint,
} from './ops.js';
import { statsFor, isFlagged } from './trust.js';
import { packTask, unpackTask } from './packet.js';

import { initProject, VERSION } from './init.js';

// ---- tiny output helpers ---------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), cyan: paint(36) };

function table(rows, headers) {
  const all = [headers, ...rows].map((r) => r.map((x) => String(x ?? '')));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((x, i) => x.padEnd(widths[i])).join('  ').trimEnd();
  return [c.bold(line(all[0])), ...all.slice(1).map(line)].join('\n');
}

function bar(fraction, width = 24) {
  const n = Math.round(fraction * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

const STATUS_COLOR = { open: c.cyan, claimed: c.yellow, review: c.blue, done: c.green, blocked: c.red };
const TIER_COLOR = { banned: c.red, fenced: c.red, new: c.dim, member: (s) => s, trusted: c.green };

function out(text = '') {
  process.stdout.write(text + '\n');
}

function splitList(values) {
  return (values ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
}

// ---- commands ----------------------------------------------------------------

const COMMANDS = {};
function command(name, { args = '', summary, options = {}, run, group = 'Volunteers' }) {
  COMMANDS[name] = { name, args, summary, options, run, group };
}

command('init', {
  group: 'Project owners',
  summary: 'Set up 0rchestrator here (--github: tasks become issues, volunteers send PRs)',
  options: { name: { type: 'string' }, private: { type: 'boolean' }, github: { type: 'boolean' }, branch: { type: 'string' } },
  run({ values }) {
    if (values.github && values.private) throw new OrchError('Private projects use packets, not public issues. Pick --github or --private.', 'USAGE');
    const res = initProject(values.root || process.cwd(), { name: values.name, isPrivate: values.private, github: values.github, branch: values.branch });
    res.created.forEach((f) => out(`${c.green('created')}  ${f}`));
    res.updated.forEach((f) => out(`${c.yellow('updated')}  ${f}`));
    res.skipped.forEach((f) => out(`${c.dim('exists')}   ${f}`));
    if (!values.github) {
      out(`\nNext: write GOAL.md, then run ${c.bold('0rch plan')} and give that prompt to your conductor agent.`);
      return;
    }
    out(`\n${c.bold('Next steps')}`);
    out(`1. Write GOAL.md and check the "setup" and "verify" commands in 0rchestrator.yml.`);
    out(`2. Plan tasks: ${c.bold('0rch plan')}, then give that prompt to your conductor agent (it runs "0rch new ...").`);
    out(`3. ${c.bold('0rch doctor')} to check everything, then commit and push. Each task becomes an issue.`);
    out(`4. Add this badge to your README so volunteers can find the tasks:\n\n${res.badge}\n`);
    out(`Full guide: https://github.com/B3Mac/0rchestrator/blob/main/docs/GETTING-STARTED.md`);
  },
});

command('doctor', {
  group: 'Project owners',
  summary: 'Check this project is ready for volunteers',
  async run({ values }) {
    const { doctor } = await import('./doctor.js');
    const results = doctor(values.root || process.cwd());
    const mark = { ok: c.green('ok   '), warn: c.yellow('warn '), error: c.red('error') };
    results.forEach((r) => out(`${mark[r.level]} ${r.msg}`));
    const errors = results.filter((r) => r.level === 'error').length;
    const warns = results.filter((r) => r.level === 'warn').length;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (errors) out(`\n${c.red(`${plural(errors, 'problem')} to fix`)}${warns ? `, ${plural(warns, 'warning')}` : ''}.`);
    else if (warns) out(`\n${c.yellow(`No blockers; ${plural(warns, 'warning')} worth a look.`)}`);
    else out(`\n${c.green('Ready for volunteers.')}`);
    return errors ? 1 : 0;
  },
});

command('status', {
  summary: 'Progress, open work and who is playing',
  options: { json: { type: 'boolean' } },
  run({ project, values }) {
    const tasks = loadTasks(project);
    const ready = computeReadiness(tasks);
    const counts = Object.fromEntries(['open', 'claimed', 'review', 'done', 'blocked'].map((s) => [s, tasks.filter((t) => t.meta.status === s).length]));
    const readyIds = tasks.filter((t) => ready.get(t.meta.id).ready).map((t) => t.meta.id);
    const players = new Set(tasks.filter((t) => t.meta.claimed_by && t.meta.status !== 'done').map((t) => t.meta.claimed_by));
    if (values.json) return out(JSON.stringify({ name: project.config.name, total: tasks.length, counts, ready: readyIds, playing: [...players] }, null, 2));
    const frac = tasks.length ? counts.done / tasks.length : 0;
    out(`${c.bold('0rchestrator')} · ${project.config.name}${project.config.visibility === 'private' ? c.dim(' (private)') : ''}`);
    out(`${bar(frac)} ${Math.round(frac * 100)}%  ${counts.done}/${tasks.length} done`);
    out(Object.entries(counts).map(([s, n]) => `${STATUS_COLOR[s](s)} ${n}`).join(' · '));
    out(`Ready to play: ${readyIds.length ? readyIds.join(', ') : c.dim('nothing right now')}`);
    if (players.size) out(`Playing now: ${[...players].join(', ')}`);
  },
});

command('list', {
  summary: 'List tasks (--ready for ones you can start)',
  options: { status: { type: 'string' }, ready: { type: 'boolean' }, json: { type: 'boolean' } },
  run({ project, values }) {
    let tasks = loadTasks(project);
    const ready = computeReadiness(tasks);
    if (values.status) tasks = tasks.filter((t) => t.meta.status === values.status);
    if (values.ready) tasks = tasks.filter((t) => ready.get(t.meta.id).ready);
    if (values.json) return out(JSON.stringify(tasks.map((t) => ({ ...t.meta, ready: ready.get(t.meta.id).ready })), null, 2));
    if (!tasks.length) return out(c.dim('No tasks match.'));
    out(table(tasks.map((t) => {
      const r = ready.get(t.meta.id);
      const note = t.meta.status === 'open' ? (r.ready ? c.green('ready') : c.dim(r.reasons.join('; '))) : (t.meta.claimed_by ? t.meta.claimed_by : '');
      const flags = [t.meta.sensitive ? 'sensitive' : '', t.meta.reward ? `${t.meta.reward} ${project.config.reward_unit}` : ''].filter(Boolean).join(', ');
      return [t.meta.id, STATUS_COLOR[t.meta.status](t.meta.status), t.meta.size, t.meta.title + (flags ? c.dim(` (${flags})`) : ''), note];
    }), ['ID', 'STATUS', 'SIZE', 'TITLE', '']));
  },
});

command('next', {
  summary: 'Show the next task you are allowed to take',
  options: { as: { type: 'string' } },
  run({ project, values }) {
    const player = resolvePlayer(project, values.as);
    const [t] = claimableTasks(project, player);
    if (!t) return out(c.dim(`Nothing ${player} can take right now.`));
    out(`${t.meta.id}  ${t.meta.title}  ${c.dim(`(${t.meta.size})`)}\nClaim it with: 0rch play --as "${player}"`);
  },
});

command('play', {
  summary: 'Claim the next task you can take and print its handoff',
  options: { as: { type: 'string' } },
  run({ project, values }) {
    guardGithubMode(project, 'play');
    const player = resolvePlayer(project, values.as);
    const task = play(project, player);
    if (!task) {
      const s = statsFor(project, player);
      out(c.dim(`Nothing ${player} can take right now (trust ${s.score}, ${s.tier}). Try again later, or run "0rch list".`));
      return;
    }
    process.stderr.write(c.green(`Claimed ${task.meta.id} for ${player}. Give everything below to your AI.\n\n`));
    out(handoffPrompt(project, task));
  },
});

command('claim', {
  args: '<id>',
  summary: 'Claim a specific task',
  options: { as: { type: 'string' }, force: { type: 'boolean' } },
  run({ project, values, positionals: [id] }) {
    guardGithubMode(project, 'claim');
    const player = resolvePlayer(project, values.as);
    const task = claimTask(project, need(id, 'task id'), player, { force: values.force });
    out(`${c.green('Claimed')} ${task.meta.id} for ${player}. Run "0rch prompt ${task.meta.id}" for the handoff.`);
  },
});

command('unclaim', {
  args: '<id>',
  summary: 'Give a task back so someone else can take it',
  options: { as: { type: 'string' } },
  run({ project, values, positionals: [id] }) {
    guardGithubMode(project, 'unclaim');
    const task = unclaimTask(project, need(id, 'task id'), { player: values.as });
    out(`Released ${task.meta.id}. It's open again.`);
  },
});

command('prompt', {
  args: '<id>',
  summary: 'Print the ready-to-paste handoff for a task',
  run({ project, positionals: [id] }) {
    out(handoffPrompt(project, getTask(project, need(id, 'task id'))));
  },
});

command('verify', {
  args: '<id>',
  summary: 'Check your work (scope + tests). Free, run it often',
  options: { base: { type: 'string' } },
  run({ project, values, positionals: [id] }) {
    const found = getTask(project, need(id, 'task id'));
    // --base: compare against a branch or commit (e.g. upstream/main) instead of where the claim started.
    const task = values.base ? { ...found, meta: { ...found.meta, base: values.base } } : found;
    const res = checkTask(project, task);
    out(colorVerify(describeVerify(res)));
    return res.passed ? 0 : 2;
  },
});

command('submit', {
  args: '<id>',
  summary: 'Verify and hand in your work for review',
  options: { as: { type: 'string' } },
  run({ project, values, positionals: [id] }) {
    if (project.config.workflow === 'github') {
      const t = getTask(project, need(id, 'task id'));
      const res = checkTask(project, t);
      out(colorVerify(describeVerify(res)));
      out(res.passed ? `\n${pullRequestHint(t)}` : `\n${c.red('Not ready.')} Fix the issues above first.`);
      return res.passed ? 0 : 2;
    }
    const { task, result } = submitTask(project, need(id, 'task id'), { player: values.as });
    out(colorVerify(describeVerify(result)));
    if (result.passed) out(`\n${c.green('Submitted')} ${task.meta.id} for review. Thanks for playing!`);
    else out(`\n${c.red('Not submitted.')} This cost a little trust score; fix the issues and submit again.`);
    return result.passed ? 0 : 2;
  },
});

command('pack', {
  group: 'Private projects',
  args: '<id>',
  summary: 'Claim a task for a volunteer and build a redacted packet',
  options: { as: { type: 'string' }, out: { type: 'string' } },
  run({ project, values, positionals: [id] }) {
    if (!values.as) throw new OrchError('Say who the packet is for: --as <volunteer>.', 'NO_PLAYER');
    const res = packTask(project, need(id, 'task id'), { player: values.as, out: values.out });
    out(`${c.green('Packed')} ${res.task.meta.id} for ${values.as}: ${res.dir}`);
    out(`${res.files.length} file(s), ${res.redactions} redacted term(s).${res.skipped.length ? ` Skipped binary: ${res.skipped.join(', ')}` : ''}`);
    out('Send that folder to the volunteer. When it comes back: 0rch unpack ' + res.task.meta.id + ' <folder>');
  },
});

command('unpack', {
  group: 'Private projects',
  args: '<id> <folder>',
  summary: 'Take a packet back: un-redact, check, and submit it',
  options: { as: { type: 'string' } },
  run({ project, values, positionals: [id, dir] }) {
    const res = unpackTask(project, need(id, 'task id'), need(dir, 'packet folder'), { player: values.as });
    out(colorVerify(describeVerify(res.result)));
    out(res.applied ? `\n${c.green('Applied')} and moved to review.` : `\n${c.red('Not applied.')} The project was left as it was.`);
    return res.result.passed ? 0 : 2;
  },
});

command('collect', {
  group: 'Project owners',
  args: '<id> <fork-url>',
  summary: "Pull a volunteer's fork or branch in for a task and check it",
  options: { branch: { type: 'string' }, as: { type: 'string' } },
  run({ project, values, positionals: [id, url] }) {
    const res = collectFork(project, need(id, 'task id'), need(url, 'fork URL'), { ref: values.branch || 'HEAD', player: values.as });
    out(`Collected ${res.commit.slice(0, 10)} from ${res.player}.`);
    out(colorVerify(describeVerify(res.result)));
    out(res.applied ? `\n${c.green('Applied')} and moved to review. Next: 0rch review ${id}` : `\n${c.red('Not applied.')} The project was left as it was.`);
    return res.result.passed ? 0 : 2;
  },
});

command('plan', {
  group: 'Conductor',
  summary: 'Print the planning prompt for your conductor agent',
  options: { batch: { type: 'string' } },
  run({ project, values }) {
    out(conductorPrompt(project, { batch: Number(values.batch) || 5 }));
  },
});

command('new', {
  group: 'Conductor',
  args: '<title>',
  summary: 'Create a task',
  options: {
    type: { type: 'string' }, size: { type: 'string' }, scope: { type: 'string', multiple: true },
    context: { type: 'string', multiple: true }, depends: { type: 'string', multiple: true },
    verify: { type: 'string' }, sensitive: { type: 'boolean' }, reward: { type: 'string' },
    goal: { type: 'string' }, accept: { type: 'string', multiple: true }, notes: { type: 'string' },
  },
  run({ project, values, positionals }) {
    const title = need(positionals.join(' '), 'title');
    const task = createTask(project, {
      title, type: values.type, size: values.size, scope: splitList(values.scope), context: splitList(values.context),
      depends_on: splitList(values.depends), verify: values.verify, sensitive: values.sensitive, reward: values.reward,
      goal: values.goal, acceptance: values.accept ?? [], notes: values.notes,
    });
    out(`${c.green('Created')} ${task.meta.id}: ${path.relative(process.cwd(), task.path)}`);
    if (!task.meta.scope.length) out(c.yellow('Warning: no --scope, so this task cannot change any files.'));
  },
});

command('review', {
  group: 'Conductor',
  args: '<id>',
  summary: 'Print the review prompt for submitted work',
  run({ project, positionals: [id] }) {
    const task = getTask(project, need(id, 'task id'));
    out(reviewPrompt(project, task, checkTask(project, task)));
  },
});

command('accept', {
  group: 'Conductor',
  args: '<id>',
  summary: 'Approve work: credit the player and commit it',
  options: { 'no-commit': { type: 'boolean' } },
  run({ project, values, positionals: [id] }) {
    const by = resolvePlayer(project);
    const { task, committed, commitError } = acceptTask(project, need(id, 'task id'), { by, commit: !values['no-commit'] });
    const s = statsFor(project, task.meta.claimed_by);
    out(`${c.green('Accepted')} ${task.meta.id}. ${task.meta.claimed_by} is now at trust ${s.score} (${s.tier}).`);
    if (committed) out(c.dim(`Committed ${committed.slice(0, 10)}.`));
    if (commitError) out(c.yellow(`Accepted, but the commit failed: ${commitError}`));
  },
});

command('reopen', {
  group: 'Conductor',
  args: '<id>',
  summary: 'Send work back with a note (costs the player trust)',
  options: { note: { type: 'string' }, 'no-penalty': { type: 'boolean' } },
  run({ project, values, positionals: [id] }) {
    const task = reopenTask(project, need(id, 'task id'), { note: values.note, by: resolvePlayer(project), penalty: !values['no-penalty'] });
    out(`Reopened ${task.meta.id}.`);
  },
});

command('release-expired', {
  group: 'Conductor',
  summary: 'Return stale claims to the pool',
  run({ project }) {
    const ids = releaseExpired(project);
    out(ids.length ? `Released ${ids.join(', ')}.` : c.dim('No expired claims.'));
  },
});

command('players', {
  group: 'Trust',
  summary: 'Trust scores for everyone (--flagged for bad actors)',
  options: { flagged: { type: 'boolean' }, json: { type: 'boolean' } },
  run({ project, values }) {
    let players = listPlayers(project);
    if (values.flagged) players = players.filter(isFlagged);
    if (values.json) return out(JSON.stringify(players.map(({ history, ...p }) => p), null, 2));
    if (!players.length) return out(c.dim(values.flagged ? 'Nobody flagged. Nice.' : 'No players yet.'));
    out(table(players.map((p) => [
      p.name, p.score, TIER_COLOR[p.tier](p.tier), p.accepted, p.reopened, p.scope_violations, p.flags.length,
      p.reliability === null ? '-' : `${p.reliability}%`, p.earned ? `${p.earned}` : '-',
    ]), ['PLAYER', 'TRUST', 'TIER', 'ACCEPTED', 'REOPENED', 'OUT-OF-SCOPE', 'FLAGS', 'RELIABILITY', `EARNED (${project.config.reward_unit})`]));
  },
});

command('player', {
  group: 'Trust',
  args: '<name>',
  summary: "One player's record and history",
  run({ project, positionals }) {
    const s = statsFor(project, need(positionals.join(' '), 'player name'));
    out(`${c.bold(s.name)}  trust ${s.score} · ${TIER_COLOR[s.tier](s.tier)} · reliability ${s.reliability === null ? '-' : s.reliability + '%'}`);
    out(`accepted ${s.accepted} · reopened ${s.reopened} · failed submits ${s.failed_submits} · out of scope ${s.scope_violations} · expired ${s.expired} · earned ${s.earned} ${project.config.reward_unit}`);
    if (s.banned) out(c.red(`BANNED${s.ban_reason ? `: ${s.ban_reason}` : ''}`));
    s.flags.forEach((f) => out(c.red(`flagged ${f.at.slice(0, 10)}${f.by ? ` by ${f.by}` : ''}: ${f.reason}`)));
    if (s.history.length) {
      out('');
      out(table(s.history.map((h) => [
        h.at.slice(0, 16).replace('T', ' '), h.type, h.task ?? '', h.delta ? (h.delta > 0 ? `+${h.delta}` : h.delta) : '', h.score, h.reason ?? h.note ?? (h.files ? h.files.join(', ') : ''),
      ]), ['WHEN', 'EVENT', 'TASK', 'PTS', 'SCORE', 'DETAIL']));
    }
  },
});

command('flag', {
  group: 'Trust',
  args: '<name>',
  summary: 'Mark a suspected bad actor and pull back their work',
  options: { reason: { type: 'string' } },
  run({ project, values, positionals }) {
    const { stats, pulled } = flagPlayer(project, need(positionals.join(' '), 'player name'), { reason: values.reason, by: resolvePlayer(project) });
    out(`${c.red('Flagged')} ${stats.name}. Trust is now ${stats.score} (${stats.tier}).${pulled.length ? ` Pulled back ${pulled.join(', ')}.` : ''}`);
  },
});

command('ban', {
  group: 'Trust',
  args: '<name>',
  summary: 'Block a player from claiming anything',
  options: { reason: { type: 'string' } },
  run({ project, values, positionals }) {
    const { stats, pulled } = banPlayer(project, need(positionals.join(' '), 'player name'), { reason: values.reason, by: resolvePlayer(project) });
    out(`${c.red('Banned')} ${stats.name}.${pulled.length ? ` Pulled back ${pulled.join(', ')}.` : ''}`);
  },
});

command('unban', {
  group: 'Trust',
  args: '<name>',
  summary: 'Lift a ban (their score stays as earned)',
  options: { reason: { type: 'string' } },
  run({ project, values, positionals }) {
    const s = unbanPlayer(project, need(positionals.join(' '), 'player name'), { reason: values.reason, by: resolvePlayer(project) });
    out(`Unbanned ${s.name}. Trust ${s.score} (${s.tier}).`);
  },
});

command('gh-event', {
  group: 'GitHub Actions',
  summary: 'Handle the current Actions event (used by the 0rchestrator workflow)',
  async run({ values }) {
    const { handleEvent } = await import('./github.js');
    const { githubClient } = await import('./github-api.js');
    const { findRoot } = await import('./project.js');
    const eventName = process.env.GITHUB_EVENT_NAME;
    const file = process.env.GITHUB_EVENT_PATH;
    if (!eventName || !file) throw new OrchError('Run this inside GitHub Actions (GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are not set).', 'USAGE');
    const root = findRoot(values.root || process.cwd());
    if (!root) throw new OrchError('No 0rchestrator.yml in this repo. Run "0rch init --github" first.', 'NO_PROJECT');
    const res = await handleEvent({
      root, eventName, payload: JSON.parse(fs.readFileSync(file, 'utf8')), api: githubClient(), log: (m) => process.stderr.write(`${m}\n`),
    });
    out(res.summary);
    writeStepSummary(res.summary);
    return res.exitCode;
  },
});

command('check-pr', {
  group: 'GitHub Actions',
  summary: "Run a task PR's checks with the base commit's rules (sandboxed tests job)",
  options: { base: { type: 'string' }, head: { type: 'string' }, title: { type: 'string' }, branch: { type: 'string' }, author: { type: 'string' } },
  async run({ values }) {
    const { checkPrTests } = await import('./github.js');
    const { findRoot } = await import('./project.js');
    const pr = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request ?? {} : {};
    const root = findRoot(values.root || process.cwd());
    if (!root) throw new OrchError('No 0rchestrator.yml here.', 'NO_PROJECT');
    const res = checkPrTests({
      root,
      base: values.base ?? pr.base?.sha,
      head: values.head ?? 'HEAD',
      title: values.title ?? pr.title,
      branch: values.branch ?? pr.head?.ref,
      author: values.author ?? pr.user?.login,
    });
    out(res.summary);
    writeStepSummary(res.summary);
    return res.exitCode;
  },
});

command('mcp', {
  group: 'Agents',
  summary: 'Run the MCP server so Claude Code, Codex and others can play directly',
  async run({ values }) {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer({ root: values.root || process.env.ORCH_ROOT || process.cwd() });
    return null;
  },
});

// ---- plumbing ------------------------------------------------------------------

function need(v, what) {
  if (v === undefined || v === null || String(v).trim() === '') throw new OrchError(`Missing ${what}.`, 'USAGE');
  return v;
}

function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${md}\n`);
}

function colorVerify(text) {
  return text
    .replace(/\bFAILED\b/g, c.red('FAILED'))
    .replace(/\bPASSED\b/g, c.green('PASSED'))
    .replace(/: ok\b/g, `: ${c.green('ok')}`);
}

function help() {
  const groups = {};
  for (const cmd of Object.values(COMMANDS)) (groups[cmd.group] ??= []).push(cmd);
  const lines = [
    `${c.bold('0rch')} ${VERSION} · volunteer your AI agent to help build open projects`,
    '',
    'Usage: 0rch <command> [args] [--root <project folder>]',
  ];
  for (const [g, cmds] of Object.entries(groups)) {
    lines.push('', c.bold(g));
    for (const cmd of cmds) lines.push(`  ${(cmd.name + ' ' + cmd.args).padEnd(26)} ${cmd.summary}`);
  }
  lines.push('', 'Who you are comes from --as, then $ORCH_VOLUNTEER, then your git user.name.');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    out(help());
    return 0;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    out(VERSION);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`Unknown command "${name}". Run "0rch help".\n`);
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { root: { type: 'string' }, ...cmd.options },
      allowPositionals: true,
      strict: true,
    });
    const standalone = ['init', 'mcp', 'doctor', 'gh-event', 'check-pr'];
    const project = standalone.includes(name) ? null : loadProject(values.root || process.cwd());
    const code = await cmd.run({ project, values, positionals });
    return code ?? 0;
  } catch (err) {
    if (err instanceof OrchError || err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err.code?.startsWith?.('ERR_PARSE_ARGS')) {
      process.stderr.write(`${c.red('error')} ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Piping into `head` closes stdout early; that's fine, not a crash.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });
  main().then((code) => {
    if (code !== null) process.exitCode = code;
  });
}
