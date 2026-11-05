import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpDir, initRepo, textkit, git, SOLUTIONS } from './helpers.js';
import { DECOMP } from '../examples/demo-solutions.js';
import { loadProject } from '../src/project.js';
import { getTask, loadTasks } from '../src/tasks.js';
import { decompScan } from '../src/decomp.js';
import {
  runTask, runLoop, parseEdits, listModels,
} from '../src/runner.js';

/** An OpenAI-compatible server that answers from a script. */
function fakeModel(answer, { models = ['qwen2.5-coder:14b'] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }));
      const j = JSON.parse(body);
      requests.push(j);
      const content = typeof answer === 'function' ? answer(j.messages, requests.length) : answer[Math.min(requests.length - 1, answer.length - 1)];
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      requests,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const fn = (sym, code) => `=== FUNCTION: src/game.c#${sym} ===\n${code}\n=== END ===`;

function mini({ github = false } = {}) {
  const dir = tmpDir('mini');
  fs.cpSync(path.join(REPO, 'examples', 'decomp-mini'), dir, { recursive: true });
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

test('run: a local model retries with the match tool\'s feedback until it matches', async () => {
  const { dir, project, idFor } = mini();
  const model = await fakeModel([
    `Trying this.\n\n${fn('Game_Clamp', 's32 Game_Clamp(s32 x, s32 lo, s32 hi) {\n    if (x < lo) return lo;\n    else if (x > hi) return hi;\n    return x;\n}')}\n\n=== FILE: tools/match.js ===\nprocess.exit(0)\n=== END ===`,
    `<think>braces, no else</think>\n${fn('Game_Clamp', DECOMP.Game_Clamp)}`,
  ]);
  try {
    const id = idFor('Game_Clamp');
    const before = fs.readFileSync(path.join(dir, 'tools/match.js'), 'utf8');
    const res = await runTask(project, id, { player: 'dave', endpoint: model.endpoint, model: 'qwen2.5-coder:14b', submit: true });
    assert.equal(res.passed, true);
    assert.equal(res.attempts, 2);
    assert.deepEqual(res.usage, { prompt_tokens: 200, completion_tokens: 40 });
    assert.equal(getTask(project, id).meta.status, 'review', '--submit hands it in');
    assert.equal(fs.readFileSync(path.join(dir, 'tools/match.js'), 'utf8'), before, 'the cheat was never written');
    const second = model.requests[1].messages;
    assert.equal(second.length, 4, 'task, last try, feedback: short enough for small contexts');
    assert.match(second[3].content, /Ignored your edit to tools\/match\.js: it's outside this task's scope/);
    assert.match(second[3].content, /Game_Clamp: \d+(\.\d)?% match/);
    const first = model.requests[0].messages[1].content;
    assert.match(first, /### src\/game\.c \(around Game_Clamp; you may only replace Game_Clamp\)/);
    assert.match(first, /glabel Game_Clamp/, 'the asm is in the prompt');
    assert.match(first, /=== FUNCTION: src\/game\.c#Game_Clamp ===/);
    assert.ok(fs.existsSync(path.join(res.runDir, 'attempt-2.md')));
  } finally {
    await model.close();
  }
});

test('run: a model can\'t change other functions, even with a FUNCTION block', async () => {
  const { dir, project, idFor } = mini();
  const model = await fakeModel([`${fn('Game_Clamp', DECOMP.Game_Clamp)}\n${fn('Game_GetScore', 's32 Game_GetScore(void) {\n    return 0;\n}')}`]);
  try {
    const res = await runTask(project, idFor('Game_Clamp'), { player: 'dave', endpoint: model.endpoint, model: 'm', attempts: 1 });
    assert.equal(res.passed, true);
    assert.match(fs.readFileSync(path.join(dir, 'src/game.c'), 'utf8'), /return gScore;/);
  } finally {
    await model.close();
  }
});

test('run: FILE, EDIT and bare code-block answers; failures put files back', async () => {
  const { project } = textkit();
  const answers = {
    'T-0001': `=== FILE: src/slugify.js ===\n\`\`\`js\n${SOLUTIONS['src/slugify.js']}\`\`\`\n=== END ===`,
    'T-0002': `=== EDIT: src/truncate.js ===\n<<<<<<< SEARCH\nexport function truncate() {\n  throw new Error('truncate() is not implemented yet');\n}\n=======\n${SOLUTIONS['src/truncate.js'].trimEnd()}\n>>>>>>> REPLACE\n=== END ===`,
    'T-0003': `Sure:\n\n\`\`\`js\n${SOLUTIONS['src/wordCount.js']}\`\`\``,
  };
  const model = await fakeModel((messages) => answers[messages[1].content.match(/handoff: (T-\d{4})/)[1]]);
  try {
    for (const id of ['T-0001', 'T-0002', 'T-0003']) {
      // One shared checkout: submit each before the next, so their changes don't mix.
      const res = await runTask(project, id, { player: 'ann', endpoint: model.endpoint, model: 'm', attempts: 1, submit: true });
      assert.equal(res.passed, true, `${id}: ${JSON.stringify(res.verify)}`);
    }
  } finally {
    await model.close();
  }

  const { dir: d2, project: p2 } = textkit();
  const stub = fs.readFileSync(path.join(d2, 'src/slugify.js'), 'utf8');
  const bad = await fakeModel(['=== FILE: src/slugify.js ===\nexport const slugify = (s) => s;\n=== END ===']);
  try {
    const res = await runTask(p2, 'T-0001', { player: 'ann', endpoint: bad.endpoint, model: 'm', attempts: 2 });
    assert.equal(res.passed, false);
    assert.equal(bad.requests.length, 2);
    assert.equal(fs.readFileSync(path.join(d2, 'src/slugify.js'), 'utf8'), stub, 'put back');
    assert.equal(git(d2, 'status', '--porcelain', '--', 'src').trim(), '');
  } finally {
    await bad.close();
  }
});

test('run --loop keeps taking tasks, and hands back the ones it can\'t do with a note', async () => {
  const { project } = textkit();
  const model = await fakeModel((messages) => {
    const id = messages[1].content.match(/handoff: (T-\d{4})/)[1];
    const file = { 'T-0001': 'src/slugify.js', 'T-0003': 'src/wordCount.js' }[id];
    return file ? `=== FILE: ${file} ===\n${SOLUTIONS[file]}=== END ===` : 'I am not sure how to do this one.';
  });
  try {
    const results = await runLoop(project, { player: 'night-shift', endpoint: model.endpoint, model: 'tiny-model', attempts: 2 });
    assert.deepEqual(results.map((r) => `${r.task.meta.id}:${r.passed}`), ['T-0001:true', 'T-0002:false', 'T-0003:true']);
    const t2 = getTask(project, 'T-0002');
    assert.equal(t2.meta.status, 'open');
    assert.match(fs.readFileSync(t2.path, 'utf8'), /## Earlier attempts\n\n- .*\(night-shift\): tiny-model \(local\) tried 2 times/);
    assert.equal(getTask(project, 'T-0001').meta.status, 'review');
  } finally {
    await model.close();
  }
});

test('run: friendly errors for no server, no model, and unclaimed GitHub tasks', async () => {
  const { project } = textkit();
  await assert.rejects(runTask(project, 'T-0001', { player: 'a', endpoint: 'http://127.0.0.1:9/v1', model: 'm' }), /Can't reach a model server at http:\/\/127\.0\.0\.1:9\/v1.*ollama serve/);
  await assert.rejects(runTask(project, 'T-0001', { player: 'a' }), /--model/);
  const { project: gh, idFor } = mini({ github: true });
  await assert.rejects(runTask(gh, idFor('Game_Clamp'), { player: 'a', model: 'm' }), /isn't claimed\. Comment \/claim/);
  await assert.rejects(runLoop(gh, { player: 'a', model: 'm' }), /--loop is for local mode/);
});

test('parseEdits: markers, fences, think tags and fallbacks', () => {
  const task = { meta: { scope: ['src/a.c#F'] } };
  assert.deepEqual(parseEdits('<think>=== FILE: x ===\nno\n=== END ===</think>\n```c\nvoid F(void) {}\n```', task), [{ kind: 'FUNCTION', rel: 'src/a.c', symbol: 'F', code: 'void F(void) {}' }]);
  assert.deepEqual(parseEdits('two\n```\na\n```\n```\nb\n```', task), []);
  const e = parseEdits('=== EDIT: `src/x.js` ===\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n=== END EDIT ===', task);
  assert.deepEqual(e, [{ kind: 'EDIT', rel: 'src/x.js', pairs: [{ search: 'a', replace: 'b' }, { search: 'c', replace: 'd' }] }]);
});

test('CLI: models, and run picks the only model when none is named', async () => {
  const { dir } = textkit();
  const model = await fakeModel([`=== FILE: src/slugify.js ===\n${SOLUTIONS['src/slugify.js']}=== END ===`], { models: ['llama3.1:8b'] });
  try {
    const env = { ORCH_LLM_ENDPOINT: model.endpoint };
    const list = await runCli(dir, ['models'], env);
    assert.equal(list.stdout.trim(), 'llama3.1:8b');
    const res = await runCli(dir, ['run', '1', '--as', 'ann'], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stderr, /Using llama3\.1:8b/);
    assert.match(res.stdout, /Passed on attempt 1\. 120 tokens of your own compute\.[\s\S]*0rch submit T-0001/);
    assert.deepEqual(await listModels({ endpoint: model.endpoint }), ['llama3.1:8b']);
  } finally {
    await model.close();
  }
});

// The CLI runs in a child process; run it asynchronously so this process can keep serving the fake model.
function runCli(dir, args, env) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(process.execPath, [path.join(REPO, 'src', 'cli.js'), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1', ...env } }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
  });
}

test('run: a model can\'t write outside the project with ../ paths', async () => {
  const { dir, project } = textkit();
  const outside = path.join(path.dirname(dir), `escaped-${path.basename(dir)}.js`);
  const model = await fakeModel([`=== FILE: src/../../${path.basename(outside)} ===\nboom\n=== END ===\n=== FILE: src/slugify.js ===\n${SOLUTIONS['src/slugify.js']}=== END ===`]);
  try {
    const res = await runTask(project, 'T-0001', { player: 'ann', endpoint: model.endpoint, model: 'm', attempts: 1 });
    assert.equal(res.passed, true);
    assert.equal(fs.existsSync(outside), false);
  } finally {
    await model.close();
  }
});
