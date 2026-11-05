#!/usr/bin/env node
// 0rchestrator showcase: two short stories, run for real against real git
// repos in a temp folder. Volunteers' AI output is simulated with ready-made
// answers (demo-solutions.js) so it runs offline in a few seconds.
//
//   npm run demo            narrated, with short pauses
//   ORCH_DEMO_FAST=1 ...    no pauses (used by the tests)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.js';
import { initProject } from '../src/init.js';
import { createTask, getTask, loadTasks } from '../src/tasks.js';
import {
  play, submitTask, acceptTask, flagPlayer, listPlayers,
} from '../src/ops.js';
import { packTask, unpackTask } from '../src/packet.js';
import { SOLUTIONS } from './demo-solutions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAST = Boolean(process.env.ORCH_DEMO_FAST);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), orange: paint('38;5;215') };

const sleep = (ms) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const say = async (line = '', pause = 450) => {
  process.stdout.write(line + '\n');
  await sleep(pause);
};
const who = (name) => c.bold(name.padEnd(8));

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'owner');
  git(dir, 'config', 'user.email', 'owner@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

async function actOne(base) {
  const dir = path.join(base, 'textkit');
  fs.cpSync(path.join(HERE, 'textkit'), dir, { recursive: true });
  repo(dir);
  const project = loadProject(dir);

  await say(c.bold(c.blue('Act 1 · An open-source sprint')));
  await say(c.dim('textkit is a tiny library with 4 tasks. The conductor already wrote the tests and stubs.'), 700);

  const claims = [];
  for (const name of ['alice', 'bob', 'mallory']) {
    const t = play(project, name);
    claims.push(t);
    await say(`${c.orange('▸')} ${who(name)} claims ${t.meta.id} ${t.meta.title}`);
  }
  await say(c.dim('  Three tasks in flight at once. T-0004 (the README) waits until all three are done.'), 800);

  for (const t of claims.filter((x) => x.meta.claimed_by !== 'mallory')) {
    write(dir, t.meta.scope[0], SOLUTIONS[t.meta.scope[0]]);
    const { result } = submitTask(project, t.meta.id);
    await say(`${c.orange('▸')} ${who(t.meta.claimed_by)} submits ${t.meta.id}: ${result.passed ? c.green('in scope, tests pass') : c.red('failed')}`);
  }

  const mal = claims.find((x) => x.meta.claimed_by === 'mallory');
  write(dir, 'src/wordCount.js', 'export const wordCount = () => 4; // looks done, isn\'t\n');
  write(dir, 'test/wordCount.test.js', "import { test } from 'node:test';\ntest('fine', () => {});\n");
  await say(`${c.orange('▸')} ${who('mallory')} fakes ${mal.meta.id}: hard-codes an answer and rewrites the tests so it "passes"`, 700);
  const sab = submitTask(project, mal.meta.id);
  await say(`${c.red('✗')} ${who('mallory')} rejected: changed ${sab.result.scope.outside.join(', ')}, which is outside the task. Trust −10`, 800);
  git(dir, 'checkout', '-q', '--', 'test/wordCount.test.js', 'src/wordCount.js');

  const flagged = flagPlayer(project, 'mallory', { reason: 'rewrote tests to fake a pass', by: 'owner' });
  await say(`${c.red('⚑')} ${who('owner')} flags mallory. Trust ${flagged.stats.score}, ${flagged.stats.tier}; ${flagged.pulled.join(', ')} goes back in the pool`, 800);
  const retry = play(project, 'mallory');
  await say(`${c.dim('  mallory tries to claim another task:')} ${retry ? c.red('allowed?!') : c.green('blocked by the fence')}`, 700);

  const carol = play(project, 'carol');
  await say(`${c.orange('▸')} ${who('carol')} claims ${carol.meta.id} ${carol.meta.title}`);
  write(dir, carol.meta.scope[0], SOLUTIONS[carol.meta.scope[0]]);
  submitTask(project, carol.meta.id);
  await say(`${c.orange('▸')} ${who('carol')} submits ${carol.meta.id}: ${c.green('in scope, tests pass')}`);

  for (const id of ['T-0001', 'T-0002', 'T-0003']) acceptTask(project, id, { by: 'owner' });
  await say(`${c.green('✓')} ${who('owner')} accepts T-0001, T-0002, T-0003. Each lands as its own commit`, 700);

  const readme = play(project, 'alice');
  await say(`${c.orange('▸')} ${who('alice')} claims ${readme.meta.id} ${readme.meta.title} ${c.dim('(just unlocked, worth 5 credits)')}`);
  write(dir, 'README.md', SOLUTIONS['README.md']);
  submitTask(project, readme.meta.id);
  acceptTask(project, readme.meta.id, { by: 'owner' });
  await say(`${c.green('✓')} ${who('owner')} accepts ${readme.meta.id}`);

  const testRun = (() => {
    try {
      execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const done = loadTasks(project).filter((t) => t.meta.status === 'done').length;
  await say(`\n  textkit: ${done}/4 tasks done, full test suite ${testRun ? c.green('passing') : c.red('failing')}, ${git(dir, 'rev-list', '--count', 'HEAD').trim()} commits.`, 900);
  return { project, testRun };
}

async function actTwo(base) {
  const dir = path.join(base, 'acme');
  fs.mkdirSync(dir, { recursive: true });
  initProject(dir, { name: 'acme-pricing', isPrivate: true });
  const cfg = path.join(dir, '0rchestrator.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('alias: Project X', 'alias: Project Falcon')
    .replace('brief: A short, non-identifying description of what the work is for.', 'brief: A pricing helper for a vehicle dealership tool.')
    .replace('    - Example Client Name\n', '    - Acme Motors\n    - /ACM-\\d{4}/\n')
    .replace('verify: npm test', 'verify: node --test'));
  write(dir, 'GOAL.md', 'Dealer pricing tools for Acme Motors.\n');
  write(dir, 'src/price.js', '// Acme Motors internal pricing. Fleet code ACM-2231.\nexport function dealerPrice(msrp) {\n  throw new Error(\'not implemented\');\n}\n');
  write(dir, 'test/price.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dealerPrice } from '../src/price.js';\n\ntest('Acme Motors dealer price is 92% of MSRP, to the dollar', () => {\n  assert.equal(dealerPrice(30000), 27600);\n  assert.equal(dealerPrice(19999), 18399);\n});\n");
  repo(dir);
  const project = loadProject(dir);
  createTask(project, {
    title: 'Implement dealerPrice() for Acme Motors', size: 'small', reward: 25,
    scope: ['src/price.js'], context: ['test/price.test.js'], verify: 'node --test test/price.test.js',
    goal: 'Implement dealerPrice(msrp) in src/price.js for Acme Motors.', acceptance: ['test/price.test.js passes'],
  });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'task');

  await say('');
  await say(c.bold(c.blue('Act 2 · A private client job')));
  await say(c.dim('A confidential repo. Volunteers never see it, only a sealed packet for one task.'), 700);

  const out = path.join(base, 'packet-for-dave');
  const packed = packTask(project, 'T-0001', { player: 'dave', out });
  await say(`${c.orange('▸')} ${who('dave')} gets a packet: ${packed.files.length} files, ${packed.redactions} private terms swapped out`);
  const seen = fs.readFileSync(path.join(out, 'files/src/price.js'), 'utf8').split('\n')[0];
  const handoff = fs.readFileSync(path.join(out, 'HANDOFF.md'), 'utf8');
  await say(`  ${c.dim("what dave's AI sees:")}   ${seen}`);
  await say(`  ${c.dim('project name it sees:')}  ${handoff.match(/working on \*\*(.+?)\*\*/)[1]}`, 800);

  const leaked = /acme|ACM-\d/i.test(fs.readdirSync(out, { recursive: true })
    .map((f) => path.join(out, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
  write(out, 'files/src/price.js', '// REDACTED_1 internal pricing. Fleet code REDACTED_2.\nexport function dealerPrice(msrp) {\n  return Math.round(msrp * 0.92);\n}\n');
  await say(`${c.orange('▸')} ${who('dave')} sends the packet back`);
  const res = unpackTask(project, 'T-0001', out, { player: 'dave' });
  await say(`${res.applied ? c.green('✓') : c.red('✗')} ${who('owner')} unpacks it: names restored, private tests ${res.result.passed ? c.green('pass') : c.red('fail')}`);
  await say(`  ${c.dim('what the owner gets:')}   ${fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8').split('\n')[0]}`, 800);
  acceptTask(project, 'T-0001', { by: 'owner' });
  await say(`${c.green('✓')} ${who('owner')} accepts T-0001. dave earns ${getTask(project, 'T-0001').meta.reward} credits`);
  return { project, leaked, applied: res.applied };
}

async function scoreboard(projects) {
  const rows = new Map();
  for (const p of projects) {
    for (const s of listPlayers(p)) {
      const r = rows.get(s.name) ?? { name: s.name, score: s.score, tier: s.tier, accepted: 0, earned: 0, flags: 0 };
      r.accepted += s.accepted;
      r.earned += s.earned;
      r.flags += s.flags.length;
      r.score = s.score;
      r.tier = s.tier;
      rows.set(s.name, r);
    }
  }
  await say('');
  await say(c.bold('Scoreboard'), 200);
  await say(c.dim('PLAYER    TRUST  TIER      ACCEPTED  CREDITS'), 100);
  for (const r of [...rows.values()].sort((a, b) => b.score - a.score)) {
    const tier = r.tier === 'fenced' ? c.red(r.tier.padEnd(8)) : r.tier.padEnd(8);
    await say(`${r.name.padEnd(8)}  ${String(r.score).padStart(5)}  ${tier}  ${String(r.accepted).padStart(8)}  ${String(r.earned).padStart(7)}`, 150);
  }
  return [...rows.values()];
}

export async function runDemo() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('The demo needs git installed.');
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '0rch-demo-'));
  await say(`${c.bold('0rchestrator')} · volunteer your AI agent ${c.dim('(demo: AI work is simulated, everything else is real)')}\n`, 600);
  const one = await actOne(base);
  const two = await actTwo(base);
  const board = await scoreboard([one.project, two.project]);
  const honest = board.filter((r) => r.flags === 0).length;
  const caught = board.length - honest;
  const tasks = board.reduce((n, r) => n + r.accepted, 0);
  await say(`\n${c.bold(`${honest} volunteers, ${tasks} tasks accepted, ${caught} saboteur${caught === 1 ? '' : 's'} caught, test suite ${one.testRun ? 'green' : 'RED'}, ${two.leaked ? 'client names LEAKED' : 'no client names leaked'}.`)}`, 0);
  await say(c.dim(`Poke around: ${base}`), 0);
  return { base, board, testsPass: one.testRun, leaked: two.leaked, privateApplied: two.applied };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDemo().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
