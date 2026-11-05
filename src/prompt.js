import fs from 'node:fs';
import path from 'node:path';
import { loadTasks, readinessFor, nextId } from './tasks.js';
import { matchesScope, scopeSymbols, splitScope } from './scope.js';
import { trackedFiles, diffAgainst, isUntracked } from './git.js';
import { verifyCommandFor, describeVerify } from './verify.js';
import { statsFor } from './trust.js';

const FILE_CAP = 20_000;
const TOTAL_CAP = 80_000;
const TREE_CAP = 400;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.0rchestrator', 'dist', 'build', '.next', '.venv', '__pycache__']);

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

/** Every file in the project, relative, without junk folders. */
export function projectFiles(root) {
  const fromGit = trackedFiles(root);
  if (fromGit) return fromGit.filter((f) => !f.split('/').some((p) => SKIP_DIRS.has(p))).sort();
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Files a task's handoff should show: its context plus whatever already exists in its scope. */
export function handoffFiles(project, task) {
  const all = projectFiles(project.root);
  const pick = new Set();
  for (const c of task.meta.context) {
    if (fs.existsSync(path.join(project.root, c)) && fs.statSync(path.join(project.root, c)).isFile()) pick.add(c);
    else all.filter((f) => matchesScope(f, [c])).slice(0, 20).forEach((f) => pick.add(f));
  }
  all.filter((f) => matchesScope(f, task.meta.scope)).slice(0, 20).forEach((f) => pick.add(f));
  return [...pick];
}

function fileBlocks(project, files, redactor) {
  let budget = TOTAL_CAP;
  const blocks = [];
  for (const rel of files) {
    let text = readIfExists(path.join(project.root, rel));
    if (text === null) {
      blocks.push(`### ${rel}\n\n_(missing)_`);
      continue;
    }
    if (text.includes('\0')) {
      blocks.push(`### ${rel}\n\n_(binary file, not shown)_`);
      continue;
    }
    if (redactor) text = redactor.redact(text);
    let note = '';
    const cap = Math.min(FILE_CAP, budget);
    if (text.length > cap) {
      text = text.slice(0, cap);
      note = '\n_(cut off here to keep the prompt short; open the file for the rest)_';
    }
    budget -= text.length;
    const f = fence(text);
    blocks.push(`### ${rel}\n\n${f}${path.extname(rel).slice(1)}\n${text}\n${f}${note}`);
    if (budget <= 0) {
      blocks.push('_(more files left out to keep the prompt short)_');
      break;
    }
  }
  return blocks.join('\n\n');
}

/** Task bodies use ## headings; inside the handoff they sit one level down. */
function demoteHeadings(md) {
  return md.replace(/^(#{1,5}) /gm, '#$1 ');
}

function projectLabel(project) {
  const c = project.config;
  return c.visibility === 'private' ? c.private.alias || 'a private project' : c.name;
}

function goalText(project) {
  const c = project.config;
  if (c.visibility === 'private') return c.private.brief || '_The owner keeps the full goal private. Work only from this task._';
  const goal = readIfExists(path.join(project.root, c.goal));
  if (!goal) return '_No GOAL.md yet._';
  return goal.length > 3000 ? goal.slice(0, 3000) + '\n\n_(goal cut off)_' : goal.trim();
}

/**
 * The ready-to-paste prompt a volunteer gives their AI.
 * mode "repo": they have the repo checked out. mode "packet": they only have a sealed packet folder.
 */
export function handoffPrompt(project, task, { mode = 'repo', redactor = null, files: withFiles = true } = {}) {
  const m = task.meta;
  const cmd = verifyCommandFor(project, task);
  const scope = m.scope.length ? m.scope.map((s) => `- \`${s}\``).join('\n') : '- _(nothing: this task should not change any files)_';
  const files = handoffFiles(project, task);

  const github = mode === 'repo' && project.config.workflow === 'github';
  const finish = mode === 'runner'
    ? [
        '- Your reply is applied and checked automatically. If the checks fail, you will see their output and can try again.',
        '- Each reply must contain all of your changes, starting from the files as shown below (not from your previous attempt).',
      ]
    : github
    ? [
        `- Work on a new branch in your fork. Never change \`${project.config.tasks_dir}/\`, \`.0rchestrator/\`, \`.github/\` or \`0rchestrator.yml\`.`,
        `- Run \`0rch verify ${m.id}\` until it passes. It checks that you stayed in scope${cmd ? ` and runs \`${cmd}\`` : ''}.`,
        `- Open a pull request titled \`${m.id}: ${m.title}\`. Its checks run automatically and a maintainer merges it.`,
        `- If the task is wrong or you are stuck, stop and explain why, then comment \`/unclaim\` on the task's issue.`,
      ]
    : mode === 'packet'
      ? [
          `- Work only inside the \`files/\` folder of this packet, and only on the scope paths above (you may add new files that match them).`,
          '- The owner runs the checks privately when the packet comes back, so make sure the acceptance criteria are met.',
          '- When you are done, send the whole packet folder back to the project owner.',
        ]
      : [
          `- When you think you are done, run \`0rch verify ${m.id}\`. It checks that you stayed in scope${cmd ? ` and runs \`${cmd}\`` : ''}.`,
          `- Fix anything it reports, then run \`0rch submit ${m.id}\`. Submitting work that fails costs trust score, so verify first.`,
          `- If the task is wrong or you are stuck, stop and explain why, then run \`0rch unclaim ${m.id}\` so someone else can take it.`,
        ];

  const text = [
    `# 0rchestrator handoff: ${m.id} · ${m.title}`,
    '',
    `You are a volunteer AI agent working on **${projectLabel(project)}** through 0rchestrator. A conductor agent split the project into small tasks; you have exactly one. Do this task and nothing else.`,
    '',
    '## Project goal',
    '',
    demoteHeadings(demoteHeadings(goalText(project))),
    '',
    `## Your task (${m.size}, ${m.type}${m.sensitive ? ', sensitive' : ''})`,
    '',
    demoteHeadings(task.body.trim()),
    '',
    '## Rules',
    '',
    scopeSymbols(m.scope).length
      ? `You may only change these paths. An entry like \`file.c#Name\` means: in that file, change only the function \`Name\` (its \`INCLUDE_ASM\` stub or its C code), and leave every other line exactly as it is.`
      : 'You may only create, change or delete these paths:',
    '',
    scope,
    '',
    '- Everything else is read-only. Changing tests, CI, dependencies, task files or `0rchestrator.yml` fails the task unless they are listed above.',
    '- Do not add new dependencies unless the task says to.',
    ...finish,
    '',
    ...(mode === 'runner' ? [] : ['## Files', '']),
    mode === 'runner' ? '' : !withFiles
      ? `_File contents left out here. In your clone, \`0rch prompt ${m.id}\` prints them: ${files.map((f) => `\`${f}\``).join(', ') || 'none listed'}._`
      : files.length ? fileBlocks(project, files) : '_No context files listed._',
    '',
  ].join('\n');
  // Redact the finished prompt in one pass so names, paths and file text all match the packet.
  return redactor ? redactor.redact(text) : text;
}

function statusTable(project, tasks) {
  const ready = readinessFor(project, tasks);
  if (!tasks.length) return '_No tasks yet._';
  const rows = tasks.map((t) => {
    const why = t.meta.status === 'open' ? (ready.get(t.meta.id).ready ? 'ready' : ready.get(t.meta.id).reasons.join('; ')) : '';
    return `| ${t.meta.id} | ${t.meta.status} | ${t.meta.size} | ${t.meta.title.replace(/\|/g, '/')} | ${t.meta.scope.join(', ')} | ${why} |`;
  });
  return ['| ID | Status | Size | Title | Scope | Notes |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

/** The prompt for the conductor agent: plan the next batch of tasks. */
export function conductorPrompt(project, { batch = 5 } = {}) {
  const tasks = loadTasks(project);
  const files = projectFiles(project.root);
  const tree = files.slice(0, TREE_CAP).join('\n') + (files.length > TREE_CAP ? `\n… and ${files.length - TREE_CAP} more` : '');
  const roadmap = readIfExists(path.join(project.root, project.config.roadmap));
  const types = Object.entries(project.config.task_types)
    .map(([name, t]) => `- \`${name}\`: verify with ${t.verify ? `\`${t.verify}\`` : 'human review (no automatic check)'}`)
    .join('\n');
  const goal = readIfExists(path.join(project.root, project.config.goal)) || '_No GOAL.md yet. Ask the owner for one before planning._';

  return [
    `# 0rchestrator conductor: plan the next tasks for ${project.config.name}`,
    '',
    'You are the conductor. You do not write the project yourself; you split the work so many volunteer AI agents can do it in parallel, then you review what comes back.',
    '',
    '## Goal',
    '',
    demoteHeadings(demoteHeadings(goal.trim())),
    '',
    '## Roadmap',
    '',
    demoteHeadings(demoteHeadings((roadmap || '_No ROADMAP.md yet. Write one: a short ordered list of milestones._').trim())),
    '',
    '## Current tasks',
    '',
    statusTable(project, tasks),
    '',
    '## Files in the project',
    '',
    '```',
    tree || '(empty)',
    '```',
    '',
    '## Your job',
    '',
    `Plan up to ${batch} new tasks that move the roadmap forward. For each one, run:`,
    '',
    '```',
    `0rch new "<title>" --type <type> --size small|medium|large --scope <paths> --context <paths> [--depends <ids>] [--verify "<command>"] [--sensitive] [--reward <n>] --goal "<goal>" --accept "<criterion>" --accept "<criterion>"`,
    '```',
    '',
    `The next free id is ${nextId(tasks)}. Then update ROADMAP.md if the plan changed.`,
    '',
    '## Planning rules',
    '',
    '- Each task must make sense to an AI that has never seen this project, using only the task text and its context files.',
    '- Scopes are an allow-list. Keep them tight, and never give two open tasks overlapping scopes unless one depends on the other.',
    '- Prefer small tasks (under ~300 changed lines). Split anything bigger.',
    '- Every code task needs a check that fails before the work and passes after. Write the tests yourself first, or make "write the tests" its own task that the implementation depends on. Never put the tests in the same scope as the code they check.',
    '- Set up interfaces and stubs first so later tasks can run in parallel against them.',
    '- Mark a task `--sensitive` if it touches security, auth, CI, secrets, payments, dependencies or infrastructure. Only highly trusted volunteers can claim those.',
    '- Do not plan work that needs private data, credentials or copyrighted assets to be shared with volunteers.',
    '',
    '## Task types in this project',
    '',
    types,
    '',
  ].join('\n');
}

/** The prompt for reviewing a submitted task. */
export function reviewPrompt(project, task, verifyResult) {
  const m = task.meta;
  const inScope = projectFiles(project.root).filter((f) => matchesScope(f, m.scope));
  const tracked = inScope.filter((f) => !isUntracked(project.root, f));
  const added = inScope.filter((f) => isUntracked(project.root, f));
  const diff = diffAgainst(project.root, m.base, tracked);
  const newFiles = added.length ? fileBlocks(project, added) : '';
  const player = m.claimed_by ? statsFor(project, m.claimed_by) : null;

  return [
    `# 0rchestrator review: ${m.id} · ${m.title}`,
    '',
    `Submitted by **${m.claimed_by ?? 'unknown'}**${player ? ` (trust ${player.score}, ${player.tier}, ${player.accepted} accepted, ${player.reopened} reopened)` : ''}.`,
    '',
    '## Task',
    '',
    demoteHeadings(task.body.trim()),
    '',
    '## Automatic checks',
    '',
    '```',
    describeVerify(verifyResult),
    '```',
    '',
    '## Changes',
    '',
    diff ? `${fence(diff)}diff\n${diff}\n${fence(diff)}` : '_No changes to existing files._',
    '',
    newFiles ? `## New files\n\n${newFiles}\n` : '',
    '## Decide',
    '',
    'Check the changes against the acceptance criteria. Look for anything that does more than the task asked: hidden network calls, obfuscated code, disabled checks, weakened tests, or new dependencies. Those are signs of sabotage.',
    '',
    `- Good: \`0rch accept ${m.id}\``,
    `- Needs work: \`0rch reopen ${m.id} --note "<what to fix>"\``,
    `- Looks malicious: \`0rch flag ${m.claimed_by ?? '<player>'} --reason "<why>"\` (a human should make this call)`,
    '',
  ].join('\n');
}
