import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  EXAMPLE, tmpDir, git, initRepo, write, cli, SOLUTIONS,
} from './helpers.js';
import { loadProject } from '../src/project.js';
import { getTask, loadTasks } from '../src/tasks.js';
import { claimTask } from '../src/ops.js';
import { statsFor, readLedger } from '../src/trust.js';
import { githubClient } from '../src/github-api.js';
import {
  handleEvent, checkPrTests, taskIdFrom, parseCommand, checkPullRequest,
} from '../src/github.js';
import { initProject } from '../src/init.js';
import { doctor } from '../src/doctor.js';

// ---- a tiny in-memory GitHub, speaking the REST shapes the client uses ----------

class FakeGitHub {
  constructor(repo = 'acme/textkit') {
    this.repo = repo;
    this.issues = [];
    this.comments = [];
    this.labels = new Set();
    this.prFiles = {};
    this.pulls = [];
    this.next = 1;
    this.fetch = this.fetch.bind(this);
  }

  issue(n) {
    return this.issues.find((i) => i.number === n);
  }

  on(n) {
    return this.comments.filter((c) => c.issue === n);
  }

  async fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    assert.match(opts.headers.Authorization, /^Bearer /);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const page = Number(u.searchParams.get('page') ?? 1);
    const pageOf = (arr) => (page === 1 ? arr : []);
    const base = `/repos/${this.repo}`;
    if (!u.pathname.startsWith(base)) return json({ message: 'Not Found' }, 404);
    const p = u.pathname.slice(base.length);
    let m;
    if (method === 'POST' && p === '/labels') {
      if (this.labels.has(body.name)) return json({ message: 'Validation Failed' }, 422);
      this.labels.add(body.name);
      return json(body, 201);
    }
    if (method === 'GET' && p === '/issues') {
      const label = u.searchParams.get('labels');
      return json(pageOf(this.issues.filter((i) => i.labels.some((l) => l.name === label))));
    }
    if (method === 'POST' && p === '/issues') {
      const issue = { number: this.next++, title: body.title, body: body.body, state: 'open', labels: body.labels.map((name) => ({ name })), assignees: [] };
      this.issues.push(issue);
      return json(issue, 201);
    }
    if ((m = p.match(/^\/issues\/(\d+)$/)) && method === 'PATCH') {
      const i = this.issue(Number(m[1]));
      i.state = body.state;
      return json(i);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
      if (method === 'POST') {
        const c = { id: 9000 + this.comments.length, issue: Number(m[1]), body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' } };
        this.comments.push(c);
        return json(c, 201);
      }
      return json(pageOf(this.on(Number(m[1]))));
    }
    if ((m = p.match(/^\/issues\/comments\/(\d+)$/)) && method === 'PATCH') {
      const c = this.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      c.edits = (c.edits ?? 0) + 1;
      return json(c);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/assignees$/)) && method === 'POST') {
      this.issue(Number(m[1])).assignees.push(...body.assignees);
      return json({}, 201);
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/files$/))) return json(pageOf((this.prFiles[m[1]] ?? []).map((filename) => ({ filename, status: 'modified' }))));
    if (method === 'GET' && p === '/pulls') return json(pageOf(this.pulls));
    return json({ message: `fake GitHub has no route for ${method} ${p}` }, 404);
  }
}

// ---- a repo on "GitHub" (a bare remote) and the Actions checkout of it ---------------

function setup() {
  const seed = tmpDir('seed');
  fs.cpSync(EXAMPLE, seed, { recursive: true });
  fs.appendFileSync(path.join(seed, '0rchestrator.yml'), '\nworkflow: github\n');
  initRepo(seed);
  const bare = path.join(tmpDir('origin'), 'textkit.git');
  git(seed, 'clone', '-q', '--bare', seed, bare);
  const clone = (who = 'owner') => {
    const dir = tmpDir(who);
    git(dir, 'clone', '-q', bare, '.');
    git(dir, 'config', 'user.name', who);
    git(dir, 'config', 'user.email', `${who}@example.com`);
    git(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  const runner = clone('runner');
  const gh = new FakeGitHub();
  const api = githubClient({ token: 't0ken', repo: gh.repo, apiUrl: 'https://api.github.test', fetchImpl: gh.fetch });
  const repository = { default_branch: 'main', full_name: gh.repo };
  const run = (eventName, payload, opts = {}) => handleEvent({ root: runner, eventName, payload: { repository, ...payload }, api, env: {}, ...opts });
  /** The project as it is on GitHub right now. */
  const origin = () => loadProject(clone('reader'));
  const issueFor = (id) => gh.issues.find((i) => i.title.startsWith(id));
  const say = (id, login, body, assoc = 'NONE', opts) => {
    const issue = issueFor(id) ?? { number: 999, title: 'Unrelated', state: 'open' };
    return run('issue_comment', {
      action: 'created', issue, comment: { id: 1, body, user: { login, type: 'User' }, author_association: assoc },
    }, opts);
  };
  const pr = (action, { number, title, login, files = [], merged = false }) => {
    gh.prFiles[number] = files;
    return run('pull_request_target', {
      action, number, sender: { login: 'owner' },
      pull_request: { number, title, merged, user: { login, type: 'User' }, head: { ref: 'patch-1', sha: 'abc' }, base: { ref: 'main', sha: 'def' } },
    });
  };
  return { bare, clone, runner, gh, run, origin, issueFor, say, pr };
}

test('pushing tasks opens one labeled issue per task, once', async () => {
  const { run, gh } = setup();
  const res = await run('push', { ref: 'refs/heads/main' });
  assert.equal(res.exitCode, 0, res.summary);
  assert.ok(gh.labels.has('0rchestrator'));
  assert.deepEqual(gh.issues.map((i) => i.title), [
    'T-0001 · Implement slugify()', 'T-0002 · Implement truncate()', 'T-0003 · Implement wordCount()', 'T-0004 · Write the README',
  ]);
  const body = gh.issues[0].body;
  assert.match(body, /Comment `\/claim` below/);
  assert.match(body, /`src\/slugify\.js`/);
  assert.match(body, /`node --test test\/slugify\.test\.js`/);
  assert.match(gh.issues[3].body, /Waiting on:\*\* T-0001, T-0002, T-0003/);
  const again = await run('push', {});
  assert.match(again.summary, /already match/);
  assert.equal(gh.issues.length, 4);
});

test('/claim claims on the default branch, replies with the handoff, and assigns', async () => {
  const env = setup();
  await env.run('push', {});
  const res = await env.say('T-0001', 'alice', '/claim');
  assert.equal(res.exitCode, 0, res.summary);
  const t = getTask(env.origin(), 'T-0001');
  assert.equal(t.meta.status, 'claimed');
  assert.equal(t.meta.claimed_by, 'alice');
  const issue = env.issueFor('T-0001');
  assert.deepEqual(issue.assignees, ['alice']);
  const reply = env.gh.on(issue.number).at(-1).body;
  assert.match(reply, /\*\*Claimed for @alice\.\*\*/);
  assert.match(reply, /<details><summary>Handoff for your AI/);
  assert.match(reply, /Open a pull request titled `T-0001: Implement slugify\(\)`/);
  assert.match(git(env.bare, 'log', '-1', '--format=%an %s'), /github-actions\[bot\] T-0001: claimed by @alice/);

  await env.say('T-0001', 'bob', '/claim');
  assert.match(env.gh.on(issue.number).at(-1).body, /@bob T-0001 is claimed by alice/);
  await env.say('T-0004', 'bob', '/claim');
  assert.match(env.gh.on(env.issueFor('T-0004').number).at(-1).body, /isn't ready: waiting on T-0001.*unlocks when/s);
});

test('two people claiming at once: the second sees the first and is told no', async () => {
  const env = setup();
  await env.run('push', {});
  const res = await env.say('T-0002', 'bob', '/claim', 'NONE', {
    beforePush: (attempt) => {
      if (attempt > 0) return;
      const other = env.clone('carol-runner');
      claimTask(loadProject(other), 'T-0002', 'carol');
      git(other, 'add', '-A');
      git(other, 'commit', '-qm', 'carol claims');
      git(other, 'push', '-q', 'origin', 'HEAD:main');
    },
  });
  assert.equal(res.exitCode, 0, res.summary);
  const p = env.origin();
  assert.equal(getTask(p, 'T-0002').meta.claimed_by, 'carol');
  assert.deepEqual(readLedger(p).map((e) => `${e.type}:${e.player}`), ['claimed:carol']);
  assert.match(env.gh.on(env.issueFor('T-0002').number).at(-1).body, /@bob T-0002 is claimed by carol/);
});

test('scope check: in-scope PRs pass; touching tests or CI fails and costs trust once', async () => {
  const env = setup();
  await env.run('push', {});
  await env.say('T-0001', 'alice', '/claim');

  const good = await env.pr('opened', { number: 101, title: 'T-0001: Implement slugify()', login: 'alice', files: ['src/slugify.js'] });
  assert.equal(good.exitCode, 0, good.summary);
  const comment = env.gh.on(101)[0];
  assert.match(comment.body, /scope check: passed/);

  const bad = await env.pr('synchronize', { number: 101, title: 'T-0001: Implement slugify()', login: 'alice', files: ['src/slugify.js', 'test/slugify.test.js', '.github/workflows/0rchestrator.yml'] });
  assert.equal(bad.exitCode, 1);
  assert.equal(env.gh.on(101).length, 1, 'one comment, updated in place');
  assert.match(env.gh.on(101)[0].body, /scope check: failed[\s\S]*no volunteer may touch: `\.github\/workflows\/0rchestrator\.yml`[\s\S]*outside the task's scope: `test\/slugify\.test\.js`/);
  await env.pr('synchronize', { number: 101, title: 'T-0001: Implement slugify()', login: 'alice', files: ['test/slugify.test.js'] });
  const p = env.origin();
  assert.equal(readLedger(p).filter((e) => e.type === 'scope_violation').length, 1);
  assert.equal(statsFor(p, 'alice').score, 40);
});

test("scope check: only the claimer's PR counts, and non-task PRs are left alone", async () => {
  const env = setup();
  await env.run('push', {});
  await env.say('T-0001', 'alice', '/claim');
  const sniper = await env.pr('opened', { number: 102, title: 'T-0001 better slugify', login: 'mallory', files: ['src/slugify.js'] });
  assert.equal(sniper.exitCode, 1);
  assert.match(env.gh.on(102)[0].body, /claimed by @alice, not @mallory/);
  assert.equal(statsFor(env.origin(), 'mallory').score, 50, 'no penalty for a PR on someone else\'s task');

  const plain = await env.pr('opened', { number: 103, title: 'Fix typo in docs', login: 'dave', files: ['README.md'] });
  assert.equal(plain.exitCode, 0);
  assert.equal(env.gh.on(103).length, 0);
});

test('merging credits the author, closes the issue and says what unlocked', async () => {
  const env = setup();
  await env.run('push', {});
  for (const [id, who] of [['T-0001', 'alice'], ['T-0002', 'bob'], ['T-0003', 'carol']]) await env.say(id, who, '/claim');
  await env.pr('closed', { number: 201, title: 'T-0001: slugify', login: 'alice', merged: true });
  await env.pr('closed', { number: 202, title: 'T-0002: truncate', login: 'bob', merged: true });
  await env.pr('closed', { number: 299, title: 'T-0003: abandoned', login: 'carol', merged: false });
  assert.equal(getTask(env.origin(), 'T-0003').meta.status, 'claimed', 'closing without merge changes nothing');
  const res = await env.pr('closed', { number: 203, title: 'T-0003: wordCount', login: 'carol', merged: true });
  assert.equal(res.exitCode, 0, res.summary);

  const p = env.origin();
  const t1 = getTask(p, 'T-0001');
  assert.equal(t1.meta.status, 'done');
  assert.equal(t1.meta.pr, 201);
  assert.equal(statsFor(p, 'alice').score, 58);
  assert.equal(env.issueFor('T-0001').state, 'closed');
  assert.match(env.gh.on(203)[0].body, /Accepted T-0003\.\*\* Thanks, @carol! Your trust score is now 58 \(member\)\. This unlocked T-0004\./);
  const accepted = readLedger(p).filter((e) => e.type === 'accepted');
  assert.deepEqual(accepted.map((e) => [e.player, e.pr, e.by]), [['alice', 201, 'owner'], ['bob', 202, 'owner'], ['carol', 203, 'owner']]);

  const twice = await env.pr('closed', { number: 203, title: 'T-0003: wordCount', login: 'carol', merged: true });
  assert.match(twice.summary, /already done/);
  assert.equal(readLedger(env.origin()).filter((e) => e.type === 'accepted').length, 3);
});

test('moderation commands are for maintainers only', async () => {
  const env = setup();
  await env.run('push', {});
  await env.say('T-0002', 'mallory', '/claim');
  await env.say('T-0002', 'eve', '/flag @mallory spam');
  const n = env.issueFor('T-0002').number;
  assert.match(env.gh.on(n).at(-1).body, /only maintainers can use `\/flag`/);
  await env.say('T-0002', 'owner', '/flag @mallory', 'OWNER');
  assert.match(env.gh.on(n).at(-1).body, /add a reason/);

  await env.say('T-0002', 'owner', '/flag @mallory rewrote the tests', 'OWNER');
  const p = env.origin();
  assert.equal(statsFor(p, 'mallory').tier, 'fenced');
  assert.equal(getTask(p, 'T-0002').meta.status, 'open', 'their claim was pulled back');
  assert.match(env.gh.on(n).at(-1).body, /Flagged @mallory: rewrote the tests\. Trust is now 0 \(fenced\)\. Pulled back T-0002/);

  await env.say('T-0003', 'mallory', '/claim');
  assert.match(env.gh.on(env.issueFor('T-0003').number).at(-1).body, /Fenced: small tasks need a trust score of 20\+/);
  await env.say('T-0003', 'owner', '/ban @mallory sock puppets', 'MEMBER');
  await env.say('T-0003', 'owner', '/unban @mallory', 'COLLABORATOR');
  assert.equal(statsFor(env.origin(), 'mallory').banned, false);

  await env.say('T-0003', 'alice', '/trust @mallory');
  assert.match(env.gh.on(env.issueFor('T-0003').number).at(-1).body, /@mallory: trust \*\*0\*\* · fenced · 0 accepted · 1 flag/);
  await env.say('T-0003', 'alice', '/help');
  assert.match(env.gh.on(env.issueFor('T-0003').number).at(-1).body, /Maintainers only/);
});

test('/unclaim, /release and /reopen', async () => {
  const env = setup();
  await env.run('push', {});
  await env.say('T-0001', 'alice', '/claim');
  await env.say('T-0001', 'bob', '/unclaim');
  assert.match(env.gh.on(env.issueFor('T-0001').number).at(-1).body, /claimed by alice, not bob/);
  await env.say('T-0001', 'alice', '/unclaim');
  assert.equal(getTask(env.origin(), 'T-0001').meta.status, 'open');
  assert.equal(statsFor(env.origin(), 'alice').score, 50);

  await env.say('T-0001', 'bob', '/claim');
  await env.say('T-0001', 'owner', '/release', 'OWNER');
  assert.equal(getTask(env.origin(), 'T-0001').meta.status, 'open');

  await env.say('T-0001', 'carol', '/claim');
  await env.say('T-0001', 'owner', '/reopen please use a regex', 'OWNER');
  const p = env.origin();
  assert.equal(statsFor(p, 'carol').score, 40);
  assert.match(fs.readFileSync(getTask(p, 'T-0001').path, 'utf8'), /please use a regex/);
});

test('expired claims are released on schedule, unless a PR is open for them', async () => {
  const env = setup();
  await env.run('push', {});
  const longAgo = new Date(Date.now() - 50 * 3600 * 1000);
  await env.say('T-0001', 'alice', '/claim', 'NONE', { now: longAgo });
  await env.say('T-0002', 'bob', '/claim', 'NONE', { now: longAgo });
  env.gh.pulls = [
    { number: 301, title: 'T-0001: almost there', head: { ref: 'x' }, user: { login: 'alice' } },
    { number: 302, title: 'T-0002 keep it locked', head: { ref: 'y' }, user: { login: 'mallory' } },
  ];
  const res = await env.run('schedule', { schedule: '17 */6 * * *' });
  assert.equal(res.exitCode, 0, res.summary);
  const p = env.origin();
  assert.equal(getTask(p, 'T-0001').meta.status, 'claimed');
  assert.equal(getTask(p, 'T-0002').meta.status, 'open');
  assert.match(env.gh.on(env.issueFor('T-0002').number).at(-1).body, /expired after 48 hours/);
});

test('sandboxed tests job: uses the base commit\'s rules, so a PR cannot rewrite its own checks', async () => {
  const env = setup();
  await env.run('push', {});
  await env.say('T-0001', 'alice', '/claim');
  const fork = env.clone('alice');
  const base = git(fork, 'rev-parse', 'HEAD').trim();
  git(fork, 'checkout', '-q', '-b', 't-0001-slugify');
  const check = (title = 'T-0001: Implement slugify()') => checkPrTests({ root: fork, base, title, branch: 't-0001-slugify', author: 'alice' });

  write(fork, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  git(fork, 'commit', '-qam', 'slugify');
  const ok = check();
  assert.equal(ok.exitCode, 0, ok.summary);
  assert.match(ok.summary, /Checks `node --test test\/slugify\.test\.js`: passed/);

  write(fork, 'src/slugify.js', 'export const slugify = (s) => s;\n');
  git(fork, 'commit', '-qam', 'oops');
  const failing = check();
  assert.equal(failing.exitCode, 1);
  assert.match(failing.summary, /\*\*failed\*\* \(exit 1\)[\s\S]*<details>/);

  // Rewrite the task so its "check" is `true`: the base commit's rules still apply.
  const taskFile = path.relative(fork, getTask(loadProject(fork), 'T-0001').path);
  write(fork, taskFile, fs.readFileSync(path.join(fork, taskFile), 'utf8').replace(/verify: .*/, 'verify: "true"'));
  git(fork, 'commit', '-qam', 'make it pass');
  const sneaky = check();
  assert.equal(sneaky.exitCode, 1);
  assert.match(sneaky.summary, /Tests were not run[\s\S]*tasks\/T-0001/);

  assert.equal(checkPrTests({ root: fork, base, title: 'Fix typo', branch: 'docs-typo', author: 'alice' }).skipped, true);
});

test('pure helpers: task ids, commands, PR rules', () => {
  assert.equal(taskIdFrom('T-0003: x'), 'T-0003');
  assert.equal(taskIdFrom('nothing', 't12-fix-it'), 'T-0012');
  assert.equal(taskIdFrom('feat/T-7'), 'T-0007');
  assert.equal(taskIdFrom('GPT3 upgrade', 'test-123'), null);
  assert.deepEqual(parseCommand('  /Flag @bob  wrote bad code\nmore'), { name: 'flag', rest: '@bob  wrote bad code', target: 'bob', reason: 'wrote bad code' });
  assert.equal(parseCommand('/deploy now'), null);
  assert.equal(parseCommand('thanks! /claim'), null);
  const { project } = { project: loadProject(EXAMPLE) };
  const r = checkPullRequest(project, { id: 'T-0001', author: 'x', files: ['src/slugify.js'] });
  assert.match(r.reasons.join(), /isn't claimed/);
});

test('init --github sets up the workflow, config and badge', () => {
  const dir = tmpDir('adopt');
  write(dir, 'package.json', '{"name":"cool-lib","scripts":{"test":"node --test"}}\n');
  write(dir, 'package-lock.json', '{}\n');
  initRepo(dir);
  git(dir, 'remote', 'add', 'origin', 'git@github.com:someone/cool-lib.git');
  const res = cli(dir, ['init', '--github']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /created {2}\.github\/workflows\/0rchestrator\.yml/);
  assert.match(res.stdout, /issues\?q=is%3Aissue\+is%3Aopen\+label%3A0rchestrator/);
  assert.match(res.stdout, /github\.com\/someone\/cool-lib/);

  const config = loadProject(dir).config;
  assert.equal(config.workflow, 'github');
  assert.equal(config.setup, 'npm ci');
  const wf = YAML.parse(fs.readFileSync(path.join(dir, '.github/workflows/0rchestrator.yml'), 'utf8'));
  assert.deepEqual(Object.keys(wf.jobs), ['scope', 'tests', 'bookkeeping']);
  assert.equal(wf.env.ORCH, 'github:B3Mac/0rchestrator#v0.2.0');
  assert.deepEqual(wf.on.push.branches, ['main']);
  assert.deepEqual(wf.jobs.tests.permissions, { contents: 'read' });
  assert.ok(!JSON.stringify(wf.jobs.scope.steps).includes('ref'), 'scope job must never check out the PR');

  const local = tmpDir('local');
  write(local, 'README.md', '# local\n');
  initRepo(local);
  cli(local, ['init']);
  assert.equal(loadProject(local).config.workflow, 'local');
  const upgrade = cli(local, ['init', '--github']);
  assert.match(upgrade.stdout, /updated {2}0rchestrator\.yml \(workflow: github\)/);
  assert.equal(loadProject(local).config.workflow, 'github');
  assert.equal(cli(local, ['init', '--github', '--private']).code, 1);
});

test('doctor catches the common setup mistakes', () => {
  const dir = tmpDir('doc');
  initProject(dir, { github: false });
  write(dir, 'tasks/T-0001-x.md', '---\nid: 1\ntitle: X\ndepends_on: [9]\nscope: []\n---\n');
  const levels = (r) => r.map((x) => `${x.level}: ${x.msg}`).join('\n');
  const r = levels(doctor(dir));
  assert.match(r, /error: Not a git repository/);
  assert.match(r, /warn: GOAL\.md still has the template text/);
  assert.match(r, /error: T-0001 depends on T-0009/);
  assert.match(r, /warn: T-0001 has no scope/);
  const good = doctor(EXAMPLE);
  assert.ok(!good.some((x) => x.level === 'error'), levels(good));
  assert.ok(loadTasks(loadProject(EXAMPLE)).length === 4);
});

test('in GitHub mode, local claim commands point to GitHub and submit points to a PR', () => {
  const env = setup();
  const dir = env.clone('volunteer');
  const play = cli(dir, ['play', '--as', 'zoe']);
  assert.equal(play.code, 1);
  assert.match(play.stderr, /GitHub mode.*comment `\/claim` on the task's GitHub issue\. Ready now: T-0001, T-0002, T-0003\./);
  assert.match(cli(dir, ['unclaim', '1']).stderr, /comment `\/unclaim`/);
  write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  const sub = cli(dir, ['submit', '1']);
  assert.equal(sub.code, 0, sub.stdout + sub.stderr);
  assert.match(sub.stdout, /gh pr create --title "T-0001: Implement slugify\(\)"/);
  assert.match(cli(dir, ['prompt', '1']).stdout, /Open a pull request titled `T-0001: Implement slugify\(\)`/);
});

test('hardening: fake task issues, huge PRs, other branches and odd names', async () => {
  const env = setup();
  await env.run('push', {});
  // An unlabeled issue someone made to look like a task.
  const fake = { number: 77, title: 'T-0001 · totally real', state: 'open', labels: [] };
  await env.run('issue_comment', { action: 'created', issue: fake, comment: { id: 5, body: '/claim', user: { login: 'eve', type: 'User' }, author_association: 'NONE' } });
  assert.equal(getTask(env.origin(), 'T-0001').meta.status, 'open');
  assert.match(env.gh.on(77)[0].body, /use `\/claim` on a task's issue/);

  await env.say('T-0001', 'alice', '/claim');
  env.gh.prFiles[401] = ['src/slugify.js'];
  const pull = (extra) => env.run('pull_request_target', {
    action: 'opened', number: 401, sender: { login: 'alice' },
    pull_request: { number: 401, title: 'T-0001: slugify', merged: false, user: { login: 'alice', type: 'User' }, head: { ref: 'p' }, base: { ref: 'main', sha: 'x' }, ...extra },
  });
  assert.equal((await pull({ changed_files: 1 })).exitCode, 0);
  const huge = await pull({ changed_files: 3500 });
  assert.equal(huge.exitCode, 1);
  assert.match(huge.summary, /Changes 3500 files, more than can be checked/);
  const other = await pull({ base: { ref: 'release-1.x', sha: 'x' } });
  assert.match(other.summary, /only PRs into main count/);

  env.gh.prFiles[402] = ['src/a`b`.js\n@everyone'];
  await env.pr('opened', { number: 402, title: 'T-0001 x', login: 'alice', files: env.gh.prFiles[402] });
  assert.match(env.gh.on(402)[0].body, /`` src\/a`b`\.js @everyone ``/);

  await env.say('T-0001', 'bob', '/trust @x](https://evil.example)');
  assert.match(env.gh.on(env.issueFor('T-0001').number).at(-1).body, /^@bob: trust/);
});
