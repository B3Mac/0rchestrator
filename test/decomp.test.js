import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpDir, git, initRepo, write, cli } from './helpers.js';
import { DECOMP, decompile } from '../examples/demo-solutions.js';
import { FakeGitHub } from './fake-github.js';
import { loadProject } from '../src/project.js';
import { getTask, loadTasks, readinessFor } from '../src/tasks.js';
import {
  claimTask, collectFork, acceptTask, checkTask, unclaimTask, noteTask,
} from '../src/ops.js';
import { statsFor, readLedger } from '../src/trust.js';
import { symbolRegion, checkSymbolChange, findStubs } from '../src/symbols.js';
import { splitScope, symbolsFor, scopesOverlap, matchesScope } from '../src/scope.js';
import { decompScan, decompProgress, countInstructions } from '../src/decomp.js';
import { handoffPrompt } from '../src/prompt.js';
import { verifyCommandFor } from '../src/verify.js';
import { githubClient } from '../src/github-api.js';
import { handleEvent, checkPrTests } from '../src/github.js';
import { checkPrLocally } from '../src/prcheck.js';

const MINI = path.join(REPO, 'examples', 'decomp-mini');
const GAME = 'src/game.c';

/** A git copy of decomp-mini with tasks for all four functions. */
function mini({ github = false } = {}) {
  const dir = tmpDir('mini');
  fs.cpSync(MINI, dir, { recursive: true });
  if (github) {
    const cfg = path.join(dir, '0rchestrator.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^workflow: local$/m, 'workflow: github'));
  }
  initRepo(dir);
  decompScan(loadProject(dir), { create: true });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'tasks');
  const project = loadProject(dir);
  const idFor = (sym) => loadTasks(project).find((t) => t.meta.scope[0].endsWith(`#${sym}`)).meta.id;
  return { dir, project, idFor };
}

const read = (dir, rel = GAME) => fs.readFileSync(path.join(dir, rel), 'utf8');

// ---- finding functions in C -----------------------------------------------------------

const SAMPLE = `#include "common.h"

/* f(x); has { braces } in a comment */
#define CALL_F(x) f(x)

s32
already_done(s32 a)
{
    if (a) { return "}"[0]; }
    return f(a);
}

INCLUDE_ASM("asm/nonmatchings/game", func_A);

INCLUDE_ASM(s32, "asm/nonmatchings/game", func_B);

#ifdef NON_MATCHING
void func_C(void) {
}
#else
INCLUDE_ASM("asm/nonmatchings/game", func_C);
#endif

#ifndef NON_MATCHING
INCLUDE_ASM("asm/nonmatchings/game", func_D);
#else
void func_D(void) {}
#endif

#pragma GLOBAL_ASM("asm/non_matchings/game/func_E.s")
`;

test('symbols: finds every way a function can appear', () => {
  const kinds = Object.fromEntries(['already_done', 'func_A', 'func_B', 'func_C', 'func_D', 'func_E', 'CALL_F', 'f'].map((s) => [s, symbolRegion(SAMPLE, s)?.kind ?? null]));
  assert.deepEqual(kinds, {
    already_done: 'definition', func_A: 'INCLUDE_ASM', func_B: 'INCLUDE_ASM', func_C: 'NON_MATCHING', func_D: 'NON_MATCHING', func_E: 'GLOBAL_ASM', CALL_F: null, f: null,
  });
  const r = symbolRegion(SAMPLE, 'already_done');
  assert.ok(SAMPLE.slice(r.start, r.end).startsWith('s32\nalready_done'), 'includes the return type line');
  assert.deepEqual(findStubs(SAMPLE).map((s) => `${s.symbol}@${s.asm}`), [
    'func_A@asm/nonmatchings/game/func_A.s', 'func_B@asm/nonmatchings/game/func_B.s', 'func_C@asm/nonmatchings/game/func_C.s',
    'func_D@asm/nonmatchings/game/func_D.s', 'func_E@asm/non_matchings/game/func_E.s',
  ]);
});

test('symbols: a change may only touch its own functions', () => {
  const doneA = SAMPLE.replace('INCLUDE_ASM("asm/nonmatchings/game", func_A);', 'void func_A(void) {\n    f(1);\n}');
  assert.deepEqual(checkSymbolChange(SAMPLE, doneA, ['func_A']), { ok: true });
  assert.match(checkSymbolChange(SAMPLE, doneA, ['func_B']).reason, /outside func_B/);
  const sneaky = doneA.replace('return f(a);', 'return 0;');
  assert.match(checkSymbolChange(SAMPLE, sneaky, ['func_A']).reason, /outside func_A \(around line 10\)/);
  const doneC = SAMPLE.replace(/#ifdef NON_MATCHING[\s\S]*?#endif\n/, 'void func_C(void) { f(2); }\n');
  assert.ok(checkSymbolChange(SAMPLE, doneC, ['func_C']).ok, 'replacing the whole NON_MATCHING block is fine');
  const both = doneC.replace('#pragma GLOBAL_ASM("asm/non_matchings/game/func_E.s")', 'void func_E(void) {}');
  assert.ok(checkSymbolChange(SAMPLE, both, ['func_E', 'func_C']).ok);
  assert.ok(checkSymbolChange(SAMPLE.replace(/\n/g, '\r\n'), doneA, ['func_A']).ok, 'line endings don\'t matter');
  assert.match(checkSymbolChange(null, doneA, ['func_A']).reason, /new file/);
  assert.match(checkSymbolChange(SAMPLE, doneA, ['nope']).reason, /doesn't contain nope/);
});

test('check commands quote what they fill in', () => {
  const task = { meta: { id: 'T-0001', type: 'decomp', scope: ['src/my file.c#Func$1', 'src/b.c#Other'], verify: './check {symbol} {file} {symbols} {task}' } };
  assert.equal(verifyCommandFor({ config: { task_types: { decomp: {} } } }, task), "./check 'Func$1' 'src/my file.c' 'Func$1' Other T-0001");
});

test('scope: function entries', () => {
  assert.deepEqual(splitScope('src/a.c#Actor_Init'), { path: 'src/a.c', symbol: 'Actor_Init' });
  assert.deepEqual(splitScope('docs/#notes.md'), { path: 'docs/#notes.md', symbol: null });
  assert.ok(matchesScope('src/a.c', ['src/a.c#X']));
  assert.deepEqual(symbolsFor('src/a.c', ['src/a.c#X', 'src/a.c#Y', 'src/b.c']), ['X', 'Y']);
  assert.equal(symbolsFor('src/a.c', ['src/a.c#X', 'src/']), null, 'a whole-file entry wins');
  assert.ok(scopesOverlap(['src/a.c#X'], ['src/a.c#Y']), 'locally, same file = overlap');
  assert.ok(!scopesOverlap(['src/a.c#X'], ['src/a.c#Y'], { bySymbol: true }));
  assert.ok(scopesOverlap(['src/a.c#X'], ['src/a.c#X'], { bySymbol: true }));
  assert.ok(scopesOverlap(['src/a.c#X'], ['src/a.c'], { bySymbol: true }));
});

// ---- scan and progress ---------------------------------------------------------------------

test('decomp scan: one task per asm function, smallest first, never twice', () => {
  const dir = tmpDir('scan');
  fs.cpSync(MINI, dir, { recursive: true });
  initRepo(dir);
  const p = loadProject(dir);
  assert.equal(countInstructions(read(dir, 'asm/nonmatchings/game/Game_Clamp.s')), 11);
  const dry = decompScan(p, {});
  assert.equal(dry.total, 4);
  assert.deepEqual(dry.chosen.map((c) => `${c.size}:${c.instructions}:${c.symbols[0]}`), ['small:8:Game_LoseLife', 'small:9:Game_AddScore', 'small:11:Game_Clamp', 'small:11:Game_SumArray']);
  assert.equal(loadTasks(p).length, 0, 'dry run creates nothing');

  const made = decompScan(p, { create: true, limit: 2 });
  assert.deepEqual(made.created, ['T-0001', 'T-0002']);
  const t = getTask(p, 'T-0001');
  assert.deepEqual(t.meta.scope, ['src/game.c#Game_LoseLife']);
  assert.deepEqual(t.meta.context, ['asm/nonmatchings/game/Game_LoseLife.s']);
  assert.equal(verifyCommandFor(p, t), 'node tools/match.js Game_LoseLife');
  const again = decompScan(p, { create: true });
  assert.equal(again.alreadyTasked, 2);
  assert.deepEqual(again.created, ['T-0003', 'T-0004']);
  assert.equal(decompScan(p, { create: true }).created.length, 0);

  const perFile = tmpDir('perfile');
  fs.cpSync(MINI, perFile, { recursive: true });
  initRepo(perFile);
  const pf = decompScan(loadProject(perFile), { create: true, perFile: true });
  assert.equal(pf.created.length, 1);
  assert.equal(getTask(loadProject(perFile), 'T-0001').meta.scope.length, 4);
  assert.throws(() => decompScan(loadProject(perFile), { type: 'nope' }), /no "nope" task type/);
});

test('decomp progress counts C vs asm', () => {
  const { dir, project, idFor } = mini();
  assert.deepEqual(decompProgress(project), {
    functions: 5, decompiled: 1, asm: 4, percent: 20, tasks: { open: 4, claimed: 0, review: 0, done: 0 }, perFile: [{ file: GAME, asm: 4, c: 1 }],
  });
  write(dir, GAME, decompile(read(dir), 'Game_Clamp', DECOMP.Game_Clamp));
  claimTask(project, idFor('Game_Clamp'), 'zoe');
  const p = decompProgress(project);
  assert.equal(p.percent, 40);
  assert.equal(p.tasks.claimed, 1);
});

// ---- doing the work ------------------------------------------------------------------------

test('verify: a function task passes on a match and fails if it touches other code', () => {
  const { dir, project, idFor } = mini();
  const id = idFor('Game_Clamp');
  claimTask(project, id, 'zoe');
  write(dir, GAME, decompile(read(dir), 'Game_Clamp', DECOMP.Game_Clamp));
  const ok = checkTask(project, getTask(project, id));
  assert.ok(ok.passed, JSON.stringify(ok, null, 1));
  assert.match(ok.command.cmd, /match\.js Game_Clamp$/);

  write(dir, GAME, read(dir).replace('return gScore;', 'return gScore + 0;'));
  const bad = checkTask(project, getTask(project, id));
  assert.equal(bad.passed, false);
  assert.match(bad.scope.symbol[0].reason, /changes code outside Game_Clamp \(around line 7\)/);
});

test('handoff explains function scopes and carries earlier attempts', () => {
  const { project, idFor } = mini();
  const id = idFor('Game_SumArray');
  claimTask(project, id, 'bob');
  unclaimTask(project, id, { player: 'bob', note: '87%: used a while loop, original is a for loop? https://decomp.me/scratch/AbC12' });
  claimTask(project, id, 'dave');
  noteTask(project, id, { note: 'trying for loop now', by: 'dave' });
  const h = handoffPrompt(project, getTask(project, id));
  assert.match(h, /`file\.c#Name` means: in that file, change only the function/);
  assert.match(h, /### Earlier attempts\n\n- \d{4}-\d\d-\d\d \(bob\): 87%: used a while loop.*decomp\.me\/scratch\/AbC12\n- \d{4}-\d\d-\d\d \(dave\): trying for loop now/);
  assert.match(h, /### asm\/nonmatchings\/game\/Game_SumArray\.s/);
});

test('GitHub mode: different functions of one file can be worked at the same time', () => {
  const local = mini();
  claimTask(local.project, local.idFor('Game_Clamp'), 'a');
  assert.throws(() => claimTask(local.project, local.idFor('Game_AddScore'), 'b'), /overlaps/);

  const gh = mini({ github: true });
  claimTask(gh.project, gh.idFor('Game_Clamp'), 'a');
  claimTask(gh.project, gh.idFor('Game_AddScore'), 'b');
  const ready = readinessFor(gh.project);
  assert.equal(ready.get(gh.idFor('Game_SumArray')).ready, true);
});

// ---- collecting forks: three-way merges, function scopes ------------------------------------

function fork(owner, who) {
  const dir = tmpDir(who);
  git(dir, 'clone', '-q', owner, '.');
  git(dir, 'config', 'user.name', who);
  git(dir, 'config', 'user.email', `${who}@example.com`);
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

test('collect: parallel forks merge cleanly; edits outside the function are refused', () => {
  const { dir, project, idFor } = mini({ github: true });
  const ids = Object.fromEntries(['Game_AddScore', 'Game_Clamp', 'Game_LoseLife', 'Game_SumArray'].map((s) => [s, idFor(s)]));
  claimTask(project, ids.Game_AddScore, 'alice');
  claimTask(project, ids.Game_Clamp, 'carol');
  claimTask(project, ids.Game_LoseLife, 'bob');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'claims');
  const forks = Object.fromEntries(['alice', 'carol', 'bob'].map((w) => [w, fork(dir, w)]));
  const work = (who, sym, extra = (t) => t) => {
    write(forks[who], GAME, extra(decompile(read(forks[who]), sym, DECOMP[sym])));
    git(forks[who], 'commit', '-qam', sym);
  };
  work('alice', 'Game_AddScore');
  work('carol', 'Game_Clamp', (t) => t.replace('return gScore;', 'return gScore; /* tidy */'));
  work('bob', 'Game_LoseLife');

  const a = collectFork(project, ids.Game_AddScore, forks.alice, { player: 'alice' });
  assert.ok(a.applied, JSON.stringify(a.result));
  acceptTask(project, ids.Game_AddScore, { by: 'owner' });

  const c = collectFork(project, ids.Game_Clamp, forks.carol, { player: 'carol' });
  assert.equal(c.applied, false);
  assert.match(c.result.scope.symbol[0].reason, /outside Game_Clamp/);
  assert.equal(statsFor(project, 'carol').scope_violations, 1);

  // Bob's fork never saw Alice's merged function; the merge keeps both.
  const b = collectFork(project, ids.Game_LoseLife, forks.bob, { player: 'bob' });
  assert.ok(b.applied, JSON.stringify(b.result));
  acceptTask(project, ids.Game_LoseLife, { by: 'owner' });
  const now = read(dir);
  assert.ok(now.includes('gScore += points * 10;') && now.includes('gLives--;'), now);
  assert.equal(git(dir, 'status', '--porcelain').trim(), '');

  // Carol fixes it; still based on the old file, still merges.
  write(forks.carol, GAME, read(forks.carol).replace(' /* tidy */', ''));
  git(forks.carol, 'commit', '-qam', 'undo tidy');
  const c2 = collectFork(project, ids.Game_Clamp, forks.carol, { player: 'carol' });
  assert.ok(c2.applied, JSON.stringify(c2.result));
  acceptTask(project, ids.Game_Clamp, { by: 'owner' });
  assert.equal(decompProgress(project).decompiled, 4);
});

test('collect: overlapping changes are a conflict, not a penalty', () => {
  const { dir, project } = mini({ github: true });
  const id = createWholeFileTask(project);
  claimTask(project, id, 'erin');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'claim');
  const f = fork(dir, 'erin');
  write(f, 'README.md', '# decomp-mini\n\nBy erin.\n');
  git(f, 'commit', '-qam', 'readme');
  write(dir, 'README.md', '# decomp-mini\n\nBy the owner.\n');
  git(dir, 'commit', '-qam', 'owner readme');
  const res = collectFork(project, id, f, { player: 'erin' });
  assert.equal(res.applied, false);
  assert.deepEqual(res.result.scope.conflicts, ['README.md']);
  assert.equal(statsFor(project, 'erin').score, 50);
  assert.match(read(dir, 'README.md'), /By the owner/);
});

function createWholeFileTask(project) {
  write(project.root, 'README.md', '# decomp-mini\n');
  git(project.root, 'add', '-A');
  git(project.root, 'commit', '-qm', 'readme');
  return cli(project.root, ['new', 'Write the README', '--type', 'docs', '--scope', 'README.md']).stdout.match(/T-\d{4}/)[0];
}

// ---- checking a PR on your own machine ----------------------------------------------------

test('0rch pr: checks scope first, then runs the full check on the PR, then puts you back', () => {
  const { dir, project, idFor } = mini({ github: true });
  const bare = path.join(tmpDir('origin'), 'mini.git');
  git(dir, 'clone', '-q', '--bare', dir, bare);
  git(dir, 'remote', 'add', 'origin', bare);
  const id = idFor('Game_SumArray');
  const f = fork(bare, 'dave');
  write(f, GAME, decompile(read(f), 'Game_SumArray', DECOMP.Game_SumArray));
  git(f, 'commit', '-qam', 'sum');
  git(f, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  write(f, GAME, read(f).replace('s32 gLives = 3;', 's32 gLives = 99;'));
  git(f, 'commit', '-qam', 'cheat');
  git(f, 'push', '-q', 'origin', 'HEAD:refs/pull/8/head');

  const before = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const good = checkPrLocally(project, 7, { task: id });
  assert.ok(good.passed, JSON.stringify(good.check));
  assert.match(good.check.output, /100% match/);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), before);
  assert.match(read(dir), /INCLUDE_ASM\("asm\/nonmatchings\/game", Game_SumArray\)/, 'back to your branch');

  const bad = checkPrLocally(project, 8, { task: id });
  assert.equal(bad.scopeOk, false);
  assert.equal(bad.check, null, 'nothing was run');

  const out = cli(dir, ['pr', '7', '--task', id]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Check: PASSED[\s\S]*Comment \/verified on PR #7/);
  write(dir, 'scratch.txt', 'x');
  git(dir, 'add', 'scratch.txt');
  assert.match(cli(dir, ['pr', '7', '--task', id]).stderr, /uncommitted changes/);
});

// ---- GitHub: function scopes in the PR checks, /verified, /note ----------------------------

function ghMini() {
  const env = mini({ github: true });
  const bare = path.join(tmpDir('origin'), 'mini.git');
  git(env.dir, 'clone', '-q', '--bare', env.dir, bare);
  const runner = fork(bare, 'runner');
  const gh = new FakeGitHub('acme/mini');
  const api = githubClient({ token: 't', repo: gh.repo, apiUrl: 'https://api.github.test', fetchImpl: gh.fetch });
  const repository = { default_branch: 'main', full_name: gh.repo };
  const run = (eventName, payload) => handleEvent({ root: runner, eventName, payload: { repository, ...payload }, api, env: {} });
  const origin = () => loadProject(fork(bare, 'reader'));
  return { ...env, bare, runner, gh, run, origin };
}

test('GitHub scope check reads both versions of a function-scoped file through the API', async () => {
  const env = ghMini();
  await env.run('push', {});
  const id = env.idFor('Game_Clamp');
  const issue = env.gh.issues.find((i) => i.title.startsWith(id));
  await env.run('issue_comment', { action: 'created', issue, comment: { id: 1, body: '/claim', user: { login: 'carol', type: 'User' }, author_association: 'NONE' } });
  const original = read(env.dir);
  const pr = async (number, after) => {
    env.gh.prFiles[number] = [GAME];
    env.gh.files[`mergebase:${GAME}`] = original;
    env.gh.files[`head${number}:${GAME}`] = after;
    return env.run('pull_request_target', {
      action: 'opened', number,
      pull_request: { number, title: `${id}: Game_Clamp`, user: { login: 'carol' }, head: { ref: 'c', sha: `head${number}` }, base: { ref: 'main', sha: 'base' }, changed_files: 1 },
    });
  };
  const good = await pr(11, decompile(original, 'Game_Clamp', DECOMP.Game_Clamp));
  assert.equal(good.exitCode, 0, good.summary);
  const bad = await pr(12, decompile(original, 'Game_Clamp', DECOMP.Game_Clamp).replace('s32 gLives = 3;', 's32 gLives = 9;'));
  assert.equal(bad.exitCode, 1);
  assert.match(env.gh.on(12)[0].body, /`src\/game\.c` changes code outside Game_Clamp \(around line 4\)/);
  assert.equal(statsFor(env.origin(), 'carol').scope_violations, 1);
});

test('sandboxed tests job: game-file checks are left to /verified, with an optional CI check', () => {
  const { dir, idFor } = mini({ github: true });
  const id = idFor('Game_AddScore');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  claimTask(loadProject(dir), id, 'alice');
  git(dir, 'commit', '-qam', 'claim');
  const claimed = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, GAME, decompile(read(dir), 'Game_AddScore', 'void Game_AddScore(s32 p) {\n    gScore += p << 3;\n}'));
  git(dir, 'commit', '-qam', 'wrong but valid C');
  const res = checkPrTests({ root: dir, base: claimed, title: `${id}: x`, author: 'alice' });
  assert.equal(res.exitCode, 0, res.summary);
  assert.match(res.summary, /needs files CI doesn't have[\s\S]*`0rch pr <number>`[\s\S]*Checks `node tools\/match\.js --syntax Game_AddScore`: passed/);
  assert.ok(base);
});

test('/verified needs trust or a maintainer, and never your own PR; /note needs the claimer', async () => {
  const env = ghMini();
  await env.run('push', {});
  const id = env.idFor('Game_Clamp');
  const issue = env.gh.issues.find((i) => i.title.startsWith(id));
  const say = (who, body, where = issue, assoc = 'NONE') => env.run('issue_comment', { action: 'created', issue: where, comment: { id: 2, body, user: { login: who, type: 'User' }, author_association: assoc } });
  await say('carol', '/claim');
  await say('mallory', '/note it is impossible');
  assert.match(env.gh.on(issue.number).at(-1).body, /only the person who claimed/);
  await say('carol', '/note 95%: register swap on lo/hi https://decomp.me/scratch/Zz9');
  assert.match(fs.readFileSync(getTask(env.origin(), id).path, 'utf8'), /## Earlier attempts\n\n- .*\(carol\): 95%: register swap/);

  const prIssue = { number: 50, title: `${id}: Game_Clamp`, state: 'open', pull_request: {}, user: { login: 'carol' }, labels: [] };
  await say('carol', '/verified', prIssue);
  assert.match(env.gh.on(50).at(-1).body, /someone else has to verify/);
  await say('newbie', '/verified', prIssue);
  assert.match(env.gh.on(50).at(-1).body, /needs trust 70\+ and 3 accepted tasks \(you have 50 and 0\)/);
  await say('owner', '/verified matches on US 1.0', prIssue, 'OWNER');
  assert.match(env.gh.on(50).at(-1).body, /\*\*Verified\*\* by @owner .*Note: matches on US 1\.0/);
  const ev = readLedger(env.origin()).find((e) => e.type === 'verified');
  assert.deepEqual([ev.player, ev.pr, ev.for, ev.task], ['owner', 50, 'carol', id]);
  assert.equal(statsFor(env.origin(), 'owner').verified, 1);
});

test('init --decomp adds the decomp task type to a new or existing project', () => {
  const fresh = tmpDir('dec');
  const r = cli(fresh, ['init', '--decomp']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0rch decomp scan/);
  const t = loadProject(fresh).config.task_types.decomp;
  assert.deepEqual([t.verify, t.ci, t.ci_verify], [null, false, null]);

  const old = tmpDir('old');
  cli(old, ['init']);
  assert.equal(loadProject(old).config.task_types.decomp, undefined);
  const up = cli(old, ['init', '--decomp']);
  assert.match(up.stdout, /updated {2}0rchestrator\.yml \(decomp task type\)/);
  assert.equal(loadProject(old).config.task_types.decomp.ci, false);
  assert.ok(loadProject(old).config.task_types.code, 'existing types kept');
});
