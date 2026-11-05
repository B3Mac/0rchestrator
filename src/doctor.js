import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { loadProject, CONFIG_FILE } from './project.js';
import { loadTasks, ACTIVE } from './tasks.js';
import { scopesOverlap, splitScope } from './scope.js';
import { verifyCommandFor } from './verify.js';
import { symbolRegion } from './symbols.js';
import { isGitRepo } from './git.js';
import { githubSlug, WORKFLOW_FILE, VERSION } from './init.js';

const onPath = (bin) => spawnSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { stdio: 'ignore' }).status === 0;

/** Check that a project is ready for volunteers. Returns [{ level: ok|warn|error, msg }]. */
export function doctor(start = process.cwd()) {
  const out = [];
  const ok = (msg) => out.push({ level: 'ok', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  const error = (msg) => out.push({ level: 'error', msg });

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else error(`Node ${process.versions.node} is too old; 0rchestrator needs 20 or newer.`);

  let project;
  try {
    project = loadProject(start);
    ok(`${CONFIG_FILE} loads (${project.config.workflow} mode, ${project.config.visibility})`);
  } catch (err) {
    error(err.message);
    return out;
  }
  const { root, config } = project;
  if (isGitRepo(root)) ok('Git repository');
  else error('Not a git repository. Scope checks need git: run "git init".');

  const goal = path.join(root, config.goal);
  if (!fs.existsSync(goal)) error(`${config.goal} is missing. Volunteers' agents read it first.`);
  else if (fs.readFileSync(goal, 'utf8').includes('Say what this project is trying to achieve')) warn(`${config.goal} still has the template text. Describe your project.`);
  else ok(`${config.goal} is written`);

  let tasks = [];
  try {
    tasks = loadTasks(project);
    ok(`${tasks.length} task${tasks.length === 1 ? '' : 's'} parse cleanly`);
  } catch (err) {
    error(err.message);
  }
  if (!tasks.length) {
    warn(config.task_types.decomp
      ? 'No tasks yet. Run "0rch decomp scan --create --limit 25" to make one per asm function.'
      : 'No tasks yet. Run "0rch plan" and give the prompt to your conductor agent.');
  }

  const ids = new Set(tasks.map((t) => t.meta.id));
  const commands = new Set(config.setup ? [config.setup] : []);
  for (const t of tasks) {
    const m = t.meta;
    if (!m.scope.length) warn(`${m.id} has no scope, so no change can ever pass.`);
    for (const d of m.depends_on) if (!ids.has(d)) error(`${m.id} depends on ${d}, which doesn't exist.`);
    if (!config.task_types[m.type]) error(`${m.id} has type "${m.type}", which ${CONFIG_FILE} doesn't define.`);
    const cmd = verifyCommandFor(project, t);
    if (cmd) commands.add(cmd.replace(/\{\w+\}/g, 'x'));
    else if (m.type === 'decomp') error(`${m.id} is a decomp task with no match check. Set task_types.decomp.verify in ${CONFIG_FILE}.`);
    else if (m.type === 'code') warn(`${m.id} is code with no automatic check. Add a verify command, or a maintainer reviews every line.`);
    for (const e of m.scope.map(splitScope).filter((x) => x.symbol)) {
      const full = path.join(root, e.path);
      if (!fs.existsSync(full)) error(`${m.id}'s scope names ${e.path}, which doesn't exist.`);
      else if (!symbolRegion(fs.readFileSync(full, 'utf8'), e.symbol)) error(`${m.id}'s scope names ${e.symbol}, which isn't in ${e.path}.`);
    }
  }
  const live = tasks.filter((t) => t.meta.status === 'open' || ACTIVE.includes(t.meta.status));
  const bySymbol = config.workflow === 'github';
  const sharedFiles = new Map();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i].meta, live[j].meta];
      const linked = a.depends_on.includes(b.id) || b.depends_on.includes(a.id);
      if (linked || !scopesOverlap(a.scope, b.scope, { bySymbol })) continue;
      if (!scopesOverlap(a.scope, b.scope, { bySymbol: true })) {
        // Different functions of the same file: fine in parallel on GitHub, one at a time locally.
        const file = a.scope.map(splitScope).find((e) => e.symbol && b.scope.map(splitScope).some((f) => f.path === e.path))?.path;
        sharedFiles.set(file, new Set([...(sharedFiles.get(file) ?? []), a.id, b.id]));
      } else {
        warn(`${a.id} and ${b.id} have overlapping scopes and don't depend on each other; only one can be worked on at a time.`);
      }
    }
  }
  for (const [file, ids] of sharedFiles) {
    warn(`${ids.size} tasks change different functions of ${file}. In local mode they run one at a time; in GitHub mode (workflow: github) they run in parallel.`);
  }
  for (const cmd of commands) {
    const bin = cmd.trim().split(/\s+/)[0];
    if (!onPath(bin)) warn(`"${bin}" (from "${cmd}") isn't installed here. Make sure your CI has it.`);
  }
  const pkg = path.join(root, 'package.json');
  if ([...commands].some((c) => /^npm (run )?test\b/.test(c)) && fs.existsSync(pkg)) {
    try {
      const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
      if (!scripts.test || /no test specified/.test(scripts.test)) warn('package.json has no real "test" script, so "npm test" checks nothing.');
    } catch {
      warn('package.json is not valid JSON.');
    }
  }

  if (config.workflow === 'github') {
    const wf = path.join(root, WORKFLOW_FILE);
    if (!fs.existsSync(wf)) {
      error(`${WORKFLOW_FILE} is missing. Run "0rch init --github".`);
    } else {
      ok(`${WORKFLOW_FILE} is in place`);
      const text = fs.readFileSync(wf, 'utf8');
      try {
        YAML.parse(text);
      } catch (err) {
        error(`${WORKFLOW_FILE} is not valid YAML: ${err.message}`);
      }
      const pinned = text.match(/0rchestrator#v([\d.]+)/)?.[1];
      if (pinned && pinned !== VERSION) warn(`The workflow uses 0rchestrator v${pinned}; this CLI is v${VERSION}.`);
    }
    const slug = githubSlug(root);
    if (slug) ok(`GitHub repo: ${slug}`);
    else warn('No GitHub "origin" remote found. Push this repo to GitHub for GitHub mode.');
  }
  return out;
}
