import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the showcase demo tells the story it claims', async () => {
  process.env.ORCH_DEMO_FAST = '1';
  process.env.NO_COLOR = '1';
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk) => { printed += chunk; return true; };
  let res;
  try {
    const { runDemo } = await import('../examples/demo.js');
    res = await runDemo();
  } finally {
    process.stdout.write = write;
  }
  assert.ok(res.testsPass, 'the finished library passes its tests');
  assert.equal(res.leaked, false, 'no client names in the packet');
  assert.ok(res.privateApplied);
  const mallory = res.board.find((r) => r.name === 'mallory');
  assert.equal(mallory.tier, 'fenced');
  assert.equal(mallory.accepted, 0);
  assert.equal(res.board.find((r) => r.name === 'dave').earned, 25);
  assert.match(printed, /5 volunteers, 9 tasks accepted, 1 saboteur caught, test suite green, no client names leaked, decomp 100% matching/);
  assert.ok(res.decomp.allMatch);
  assert.equal(res.decomp.localRun.attempts, 2, 'the local model needed the feedback once');
  assert.match(printed, /carol .*changes code outside Game_Clamp/);
  assert.equal(res.board.find((r) => r.name === 'alice').accepted, 3);
});
