import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { textkit, tmpDir, cli, write, CLI, SOLUTIONS } from './helpers.js';

test('cli: init, new, list, status in a fresh folder', () => {
  const dir = tmpDir('cli');
  assert.equal(cli(dir, ['init', '--name', 'demo']).code, 0);
  assert.ok(fs.existsSync(path.join(dir, '0rchestrator.yml')));
  assert.ok(fs.existsSync(path.join(dir, '.0rchestrator/PLAYER.md')));
  const made = cli(dir, ['new', 'Add a thing', '--scope', 'src/a.js,src/b.js', '--accept', 'It works']);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /Created T-0001/);
  const task = fs.readFileSync(path.join(dir, 'tasks/T-0001-add-a-thing.md'), 'utf8');
  assert.match(task, /scope:\n {2}- src\/a\.js\n {2}- src\/b\.js/);
  assert.match(cli(dir, ['list']).stdout, /T-0001\s+open\s+small\s+Add a thing\s+ready/);
  assert.match(cli(dir, ['status']).stdout, /Ready to play: T-0001/);
});

test('cli: clear errors and exit codes', () => {
  const dir = tmpDir('cli');
  const none = cli(dir, ['list']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /0rch init/);
  assert.equal(cli(dir, ['nope']).code, 1);
  const { dir: tk } = textkit();
  assert.match(cli(tk, ['claim', '99', '--as', 'x']).stderr, /No task T-0099/);
  assert.match(cli(tk, ['list', '--bogus']).stderr, /Unknown option/);
});

test('cli: a full volunteer round trip', () => {
  const { dir } = textkit();
  const played = cli(dir, ['play', '--as', 'alice']);
  assert.equal(played.code, 0);
  assert.match(played.stdout, /# 0rchestrator handoff: T-0001/);
  assert.equal(cli(dir, ['verify', '1']).code, 2, 'stub fails its tests');
  write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
  assert.equal(cli(dir, ['verify', '1']).code, 0);
  assert.equal(cli(dir, ['submit', '1', '--as', 'alice']).code, 0);
  const acc = cli(dir, ['accept', '1']);
  assert.match(acc.stdout, /alice is now at trust 58 \(member\)/);
  assert.match(cli(dir, ['players']).stdout, /alice\s+58\s+member\s+1/);
  assert.match(cli(dir, ['player', 'alice']).stdout, /accepted\s+T-0001\s+\+8\s+58/);
});

test('mcp: a volunteer agent can play, verify and submit over MCP', async () => {
  const { dir } = textkit();
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--root', dir],
    env: { ...process.env, ORCH_VOLUNTEER: 'agent-smith' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['orch_status', 'orch_play', 'orch_verify', 'orch_submit', 'orch_plan', 'orch_new_task', 'orch_review']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.ok(!names.some((n) => /accept|flag|ban/.test(n)), 'humans keep accept/flag/ban');

    const call = async (name, args = {}) => (await client.callTool({ name, arguments: args }));
    const played = await call('orch_play', {});
    assert.match(played.content[0].text, /Claimed T-0001 for agent-smith/);

    write(dir, 'src/slugify.js', SOLUTIONS['src/slugify.js']);
    assert.match((await call('orch_verify', { task_id: '1' })).content[0].text, /Result: PASSED/);
    assert.match((await call('orch_submit', { task_id: 'T-0001' })).content[0].text, /submitted for review/);

    const bad = await call('orch_claim', { task_id: '42' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /No task T-0042/);

    const status = JSON.parse((await call('orch_status')).content[0].text);
    assert.equal(status.counts.review, 1);
  } finally {
    await client.close();
  }
});
