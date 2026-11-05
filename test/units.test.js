import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesScope, scopesOverlap, staticPrefix } from '../src/scope.js';
import { parseTask, serializeTask, normalizeId, computeReadiness } from '../src/tasks.js';
import { tierFor, canClaim, pointsFor } from '../src/trust.js';
import { Redactor } from '../src/redact.js';
import { DEFAULTS, mergeDeep } from '../src/project.js';

const trust = DEFAULTS.trust;

test('scope: files, folders and globs', () => {
  assert.ok(matchesScope('src/a.js', ['src/a.js']));
  assert.ok(!matchesScope('src/ab.js', ['src/a.js']));
  assert.ok(matchesScope('src/x/y.js', ['src/']));
  assert.ok(matchesScope('src/x/y.js', ['src']));
  assert.ok(!matchesScope('srcx/y.js', ['src']));
  assert.ok(matchesScope('docs/a.md', ['docs/*.md']));
  assert.ok(!matchesScope('docs/deep/a.md', ['docs/*.md']));
  assert.ok(matchesScope('docs/deep/a.md', ['docs/**/*.md']));
  assert.ok(matchesScope('docs/a.md', ['docs/**/*.md']));
  assert.ok(matchesScope('./src/a.js', ['src/a.js']));
  assert.ok(!matchesScope('test/a.test.js', ['src/**']));
});

test('scope: overlap is exact for files and conservative for globs', () => {
  assert.equal(staticPrefix('src/**/*.js'), 'src');
  assert.ok(!scopesOverlap(['src/a.js'], ['src/b.js']));
  assert.ok(scopesOverlap(['src/a.js'], ['src/a.js']));
  assert.ok(scopesOverlap(['src/'], ['src/a.js']));
  assert.ok(scopesOverlap(['src/*.js'], ['src/b.js']));
  assert.ok(!scopesOverlap(['src/*.js'], ['test/b.js']));
  assert.ok(!scopesOverlap([], ['src/a.js']));
});

test('tasks: ids normalize and files round-trip', () => {
  assert.equal(normalizeId('3'), 'T-0003');
  assert.equal(normalizeId('t-12'), 'T-0012');
  assert.equal(normalizeId('T-0007'), 'T-0007');
  const src = '---\nid: 5\ntitle: Do it\nscope: src/a.js\n---\n\n## Goal\n\nThing.\n';
  const t = parseTask(src);
  assert.equal(t.meta.id, 'T-0005');
  assert.deepEqual(t.meta.scope, ['src/a.js']);
  assert.equal(t.meta.status, 'open');
  const again = parseTask(serializeTask(t));
  assert.deepEqual(again.meta, t.meta);
  assert.equal(again.body.trim(), t.body.trim());
});

test('tasks: bad front matter is a clear error', () => {
  assert.throws(() => parseTask('no front matter'), /front matter/);
  assert.throws(() => parseTask('---\ntitle: x\n---\n'), /needs an "id"/);
  assert.throws(() => parseTask('---\nid: 1\ntitle: x\nstatus: maybe\n---\n'), /status must be/);
});

test('tasks: readiness follows dependencies and active scopes', () => {
  const mk = (id, status, scope, deps = []) => ({ meta: { id, status, scope, depends_on: deps } });
  const tasks = [
    mk('T-0001', 'done', ['a.js']),
    mk('T-0002', 'claimed', ['b.js']),
    mk('T-0003', 'open', ['c.js'], ['T-0001']),
    mk('T-0004', 'open', ['d.js'], ['T-0002']),
    mk('T-0005', 'open', ['b.js']),
  ];
  const r = computeReadiness(tasks);
  assert.equal(r.get('T-0003').ready, true);
  assert.match(r.get('T-0004').reasons.join(), /waiting on T-0002/);
  assert.match(r.get('T-0005').reasons.join(), /overlaps T-0002/);
});

test('trust: tiers and fences', () => {
  const s = (score, accepted, extra = {}) => ({ name: 'p', score, accepted, banned: false, ...extra });
  const task = (size, sensitive = false) => ({ meta: { size, sensitive } });
  assert.equal(tierFor(s(50, 0), trust), 'new');
  assert.equal(tierFor(s(10, 4), trust), 'fenced');
  assert.equal(tierFor(s(60, 2), trust), 'member');
  assert.equal(tierFor(s(90, 6), trust), 'trusted');
  assert.equal(tierFor(s(90, 6, { banned: true }), trust), 'banned');

  assert.ok(canClaim(s(50, 0), task('small'), trust).ok);
  assert.match(canClaim(s(50, 0), task('medium'), trust).reason, /1 accepted/);
  assert.ok(canClaim(s(50, 1), task('medium'), trust).ok);
  assert.match(canClaim(s(55, 3), task('large'), trust).reason, /score of 60/);
  assert.match(canClaim(s(70, 9), task('small', true), trust).reason, /sensitive/);
  assert.match(canClaim(s(99, 9, { banned: true, ban_reason: 'spam' }), task('small'), trust).reason, /banned \(spam\)/);
});

test('trust: points per event', () => {
  assert.equal(pointsFor({ type: 'accepted', size: 'large' }, trust), 25);
  assert.equal(pointsFor({ type: 'reopened' }, trust), -10);
  assert.equal(pointsFor({ type: 'reopened', penalty: false }, trust), 0);
  assert.equal(pointsFor({ type: 'claimed' }, trust), 0);
});

test('redact: names become placeholders and come back exactly', () => {
  const r = new Redactor(['Acme Motors', '/ACM-\\d{4}/']);
  const out = r.redact('acme motors and Acme Motors use ACM-1234 and ACM-9999');
  assert.ok(!/acme|ACM-\d/i.test(out));
  assert.equal(r.restore(out), 'acme motors and Acme Motors use ACM-1234 and ACM-9999');
  const again = new Redactor(['Acme Motors'], r.mapping());
  assert.equal(again.redact('Acme Motors'), r.redact('Acme Motors'));
});

test('config: deep merge keeps defaults', () => {
  const merged = mergeDeep(DEFAULTS, { trust: { starting_score: 30 } });
  assert.equal(merged.trust.starting_score, 30);
  assert.equal(merged.trust.fences.small.min_score, 20);
});
