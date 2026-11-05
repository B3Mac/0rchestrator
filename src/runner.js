import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchError } from './errors.js';
import { getTask } from './tasks.js';
import {
  claimTask, unclaimTask, checkTask, submitTask, claimableTasks, releaseExpired,
} from './ops.js';
import { handoffPrompt, fence } from './prompt.js';
import { splitScope, symbolsFor, matchesScope } from './scope.js';
import { symbolRegion } from './symbols.js';
import { describeVerify } from './verify.js';
import { playerKey } from './trust.js';
import { isProtected } from './project.js';

// `0rch run`: a small agent loop for models that don't come with one
// (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible API). The
// model proposes edits as text; 0rch applies only the ones inside the task's
// scope, runs the task's check, and sends failures back for another try.

export const DEFAULT_ENDPOINT = 'http://localhost:11434/v1';
const FEEDBACK_TAIL = 3500;
const EXCERPT_LINES = 40;

// ---- talking to the model --------------------------------------------------------

function apiUrl(endpoint, suffix) {
  return `${String(endpoint).replace(/\/+$/, '')}${suffix}`;
}

function unreachable(endpoint, err) {
  const local = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(endpoint);
  const hint = local
    ? ' Is your model server running? Ollama: "ollama serve". LM Studio: start the local server (usually --endpoint http://localhost:1234/v1).'
    : '';
  return new OrchError(`Can't reach a model server at ${endpoint} (${err.cause?.code ?? err.message}).${hint}`, 'NO_MODEL_SERVER');
}

async function call(fetchImpl, url, init, endpoint) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (err.name === 'TimeoutError') throw new OrchError(`The model took too long to answer (raise --timeout).`, 'MODEL_TIMEOUT');
    throw unreachable(endpoint, err);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; reported below
  }
  if (!res.ok) throw new OrchError(`The model server said ${res.status}: ${data?.error?.message ?? data?.error ?? text.slice(0, 300)}`, 'MODEL_ERROR');
  return data;
}

/** Models the server offers (OpenAI-style GET /models). */
export async function listModels({ endpoint = DEFAULT_ENDPOINT, apiKey, fetchImpl = globalThis.fetch } = {}) {
  const data = await call(fetchImpl, apiUrl(endpoint, '/models'), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  }, endpoint);
  return (data?.data ?? data?.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
}

export async function chat({ endpoint, model, apiKey, messages, temperature = 0.2, timeoutSeconds = 600, fetchImpl = globalThis.fetch }) {
  const data = await call(fetchImpl, apiUrl(endpoint, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, temperature, stream: false }),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  }, endpoint);
  const text = data?.choices?.[0]?.message?.content ?? '';
  return { text: String(text), usage: data?.usage ?? null };
}

// ---- what the model sees -----------------------------------------------------------

function numbered(text, from = 1) {
  return text.split('\n').map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
}

/** For function-scoped files: the top of the file plus the function and its neighbours. */
function excerpt(text, symbol) {
  const r = symbolRegion(text, symbol);
  const all = text.split('\n');
  if (!r) return text;
  const startLine = text.slice(0, r.start).split('\n').length;
  const endLine = text.slice(0, r.end).split('\n').length;
  const head = all.slice(0, Math.min(30, startLine - 1));
  const from = Math.max(head.length + 1, startLine - EXCERPT_LINES);
  const to = Math.min(all.length, endLine + EXCERPT_LINES);
  const parts = [head.join('\n')];
  if (from > head.length + 1) parts.push('/* ... */');
  parts.push(all.slice(from - 1, to).join('\n'));
  if (to < all.length) parts.push('/* ... */');
  return parts.join('\n');
}

function readText(root, rel) {
  const full = path.join(root, rel);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
}

function filesSection(project, task, originals, budget) {
  const blocks = [];
  let left = budget;
  const add = (title, body, lang = '') => {
    if (left <= 0) return;
    let b = body;
    if (b.length > left) b = `${b.slice(0, left)}\n/* cut off: too long for the context budget */`;
    left -= b.length;
    const f = fence(b);
    blocks.push(`### ${title}\n\n${f}${lang}\n${b}\n${f}`);
  };
  const ext = (rel) => path.extname(rel).slice(1);
  for (const entry of task.meta.scope) {
    const { path: rel, symbol } = splitScope(entry);
    const text = originals.get(rel);
    if (symbol && text) add(`${rel} (around ${symbol}; you may only replace ${symbol})`, excerpt(text, symbol), ext(rel));
    else if (text !== undefined && text !== null) add(`${rel} (in scope)`, text, ext(rel));
    else if (!/[*?[]/.test(rel)) blocks.push(`### ${rel} (in scope)\n\n_Doesn't exist yet. Create it._`);
  }
  for (const rel of task.meta.context) {
    const text = readText(project.root, rel);
    if (text === null) blocks.push(`### ${rel}\n\n_(not found on this machine${/\.s$/.test(rel) ? '; run the project\'s setup to extract it from your copy of the game' : ''})_`);
    else add(`${rel} (read-only)`, /\.s$/.test(rel) ? text : text, ext(rel));
  }
  return blocks.join('\n\n');
}

function formatRules(task) {
  const fnEntries = task.meta.scope.map(splitScope).filter((e) => e.symbol);
  const fileEntries = task.meta.scope.map(splitScope).filter((e) => !e.symbol);
  const lines = ['## How to answer', '', 'Reply with edit blocks only. You can add one short sentence before them.', ''];
  if (fnEntries.length) {
    lines.push('To write a function, give its complete C definition. It replaces the stub or old version:', '');
    lines.push('=== FUNCTION: ' + `${fnEntries[0].path}#${fnEntries[0].symbol}` + ' ===', '<the whole function, signature and body>', '=== END ===', '');
  }
  if (fileEntries.length) {
    lines.push('To write a whole file (best for new or short files):', '', '=== FILE: path/to/file ===', '<the complete new contents>', '=== END ===', '');
    lines.push('To change part of a longer file, copy the exact lines to replace:', '', '=== EDIT: path/to/file ===', '<<<<<<< SEARCH', '<exact existing lines>', '=======', '<new lines>', '>>>>>>> REPLACE', '=== END ===', '');
  }
  lines.push(`Only these may change: ${task.meta.scope.map((s) => `\`${s}\``).join(', ')}. Edits to anything else are thrown away.`);
  return lines.join('\n');
}

export const SYSTEM_PROMPT = [
  'You are a careful programmer doing one small task in an open-source project, through 0rchestrator.',
  'You cannot run commands. Your edits are applied for you and the task\'s checks are run; you will be told the results.',
  'Change only what the task needs, keep the project\'s style, and never edit tests to make them pass.',
].join(' ');

// ---- reading the model's answer --------------------------------------------------------

function unfence(body) {
  const t = body.replace(/^\n+|\s+$/g, '');
  const m = t.match(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
  return m ? m[2] : t;
}

/** Parse FUNCTION / FILE / EDIT blocks. Falls back to a lone code block when the task has one target. */
export function parseEdits(text, task) {
  const clean = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const edits = [];
  const re = /^[ \t]*={3}\s*(FUNCTION|FILE|EDIT)\s*:\s*(.+?)\s*={3}[ \t]*\n([\s\S]*?)^[ \t]*={3}\s*END(?:\s+\w+)?\s*={3}[ \t]*$/gm;
  let m;
  while ((m = re.exec(clean))) {
    const kind = m[1];
    const target = m[2].trim().replace(/^`|`$/g, '');
    const body = m[3];
    if (kind === 'FUNCTION') {
      const { path: rel, symbol } = splitScope(target);
      edits.push({ kind, rel, symbol, code: unfence(body) });
    } else if (kind === 'FILE') {
      edits.push({ kind, rel: splitScope(target).path, content: `${unfence(body).replace(/\s+$/, '')}\n` });
    } else {
      const pairs = [...body.matchAll(/<{7}\s*SEARCH\s*\n([\s\S]*?)\n={7}\s*\n([\s\S]*?)\n?>{7}\s*REPLACE/g)].map((p) => ({ search: p[1], replace: p[2] }));
      edits.push({ kind, rel: splitScope(target).path, pairs });
    }
  }
  if (edits.length) return edits;
  // Small models often just answer with one code block.
  const blocks = [...clean.matchAll(/(`{3,})[^\n]*\n([\s\S]*?)\n\1/g)].map((b) => b[2]);
  if (blocks.length === 1 && task.meta.scope.length === 1) {
    const { path: rel, symbol } = splitScope(task.meta.scope[0]);
    if (symbol) return [{ kind: 'FUNCTION', rel, symbol, code: blocks[0] }];
    if (!/[*?[]/.test(rel)) return [{ kind: 'FILE', rel, content: `${blocks[0].replace(/\s+$/, '')}\n` }];
  }
  return [];
}

/**
 * Apply edits to the original files (each attempt starts fresh). Returns the
 * new contents per file and the problems with edits that were refused.
 */
export function applyEdits(project, task, originals, edits) {
  const next = new Map();
  const problems = [];
  const current = (rel) => (next.has(rel) ? next.get(rel) : originals.get(rel) ?? null);
  for (const e of edits) {
    const parts = String(e.rel).split(/[\\/]/);
    if (!e.rel || path.isAbsolute(e.rel) || parts.includes('..') || /^[A-Za-z]:/.test(e.rel)) {
      problems.push(`Ignored your edit to ${e.rel}: paths must stay inside the project.`);
      continue;
    }
    if (isProtected(project, e.rel) || !matchesScope(e.rel, task.meta.scope)) {
      problems.push(`Ignored your edit to ${e.rel}: it's outside this task's scope.`);
      continue;
    }
    const allowed = symbolsFor(e.rel, task.meta.scope);
    if (e.kind === 'FUNCTION') {
      if (allowed && !allowed.includes(e.symbol)) {
        problems.push(`Ignored your edit to ${e.symbol}: this task may only change ${allowed.join(', ')} in ${e.rel}.`);
        continue;
      }
      const text = current(e.rel);
      const region = text && symbolRegion(text, e.symbol);
      if (!region) {
        problems.push(`Couldn't find ${e.symbol} in ${e.rel} to replace.`);
        continue;
      }
      next.set(e.rel, `${text.slice(0, region.start)}${e.code.replace(/\s+$/, '')}\n${text.slice(region.end)}`);
    } else if (allowed) {
      problems.push(`Ignored your ${e.kind} edit to ${e.rel}: in this file you may only replace ${allowed.join(', ')}, so use a FUNCTION block.`);
    } else if (e.kind === 'FILE') {
      next.set(e.rel, e.content);
    } else {
      let text = current(e.rel);
      if (text === null) {
        problems.push(`Can't EDIT ${e.rel}: it doesn't exist. Use a FILE block to create it.`);
        continue;
      }
      for (const { search, replace } of e.pairs) {
        const at = text.indexOf(search);
        if (at === -1 || text.indexOf(search, at + 1) !== -1) {
          problems.push(`An EDIT for ${e.rel} didn't apply: its SEARCH text ${at === -1 ? 'is not in the file' : 'appears more than once'}.`);
          continue;
        }
        text = text.slice(0, at) + replace + text.slice(at + search.length);
      }
      next.set(e.rel, text);
    }
  }
  return { next, problems };
}

function writeFiles(root, files) {
  for (const [rel, content] of files) {
    const full = path.join(root, rel);
    if (content === null) fs.rmSync(full, { force: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

function feedbackFor(verify, problems) {
  const parts = [];
  if (problems.length) parts.push(problems.map((p) => `- ${p}`).join('\n'));
  let report = describeVerify(verify);
  if (report.length > FEEDBACK_TAIL) report = `…${report.slice(-FEEDBACK_TAIL)}`;
  parts.push(`The checks failed:\n\n${fence(report)}\n${report}\n${fence(report)}`);
  parts.push('Fix it and reply with all of your edit blocks again.');
  return parts.join('\n\n');
}

// ---- the loop ------------------------------------------------------------------------

/**
 * Work one task with a model. Resolves to { task, passed, attempts, usage, runDir }.
 * On failure every file in scope is put back the way it was.
 */
export async function runTask(project, id, {
  player, endpoint = DEFAULT_ENDPOINT, model, apiKey, attempts = 3, temperature = 0.2, timeoutSeconds = 600,
  contextChars = 24_000, submit = false, keep = false, fetchImpl = globalThis.fetch, log = () => {}, now = () => new Date(),
} = {}) {
  if (!model) throw new OrchError('Say which model to use: --model <name>. "0rch models" lists what your server has.', 'USAGE');
  let task = getTask(project, id);
  const github = project.config.workflow === 'github';
  if (task.meta.status === 'open' && !github) task = claimTask(project, id, player, { now: now() });
  else if (task.meta.status === 'open') {
    throw new OrchError(`${task.meta.id} isn't claimed. Comment /claim on its GitHub issue, pull the latest changes, then run this again.`, 'NOT_CLAIMED');
  }
  if (task.meta.status !== 'claimed') throw new OrchError(`${task.meta.id} is ${task.meta.status}; only claimed tasks can be worked on.`, 'NOT_CLAIMED');
  if (player && playerKey(task.meta.claimed_by) !== playerKey(player)) {
    throw new OrchError(`${task.meta.id} is claimed by ${task.meta.claimed_by}, not ${player}.`, 'NOT_YOURS');
  }

  const scopeFiles = [...new Set(task.meta.scope.map((e) => splitScope(e).path).filter((p) => !/[*?[]/.test(p)))];
  const originals = new Map(scopeFiles.map((rel) => [rel, readText(project.root, rel)]));
  const restore = () => writeFiles(project.root, new Map([...originals].map(([rel, text]) => [rel, text])));

  const handoff = handoffPrompt(project, task, { mode: 'runner' });
  const user = `${handoff}\n## Files\n\n${filesSection(project, task, originals, contextChars)}\n\n${formatRules(task)}`;
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `0rch-run-${task.meta.id}-`));
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let verify = null;

  for (let n = 1; n <= attempts; n++) {
    log(`Attempt ${n}/${attempts}: asking ${model}…`);
    const started = Date.now();
    const reply = await chat({ endpoint, model, apiKey, messages, temperature, timeoutSeconds, fetchImpl });
    usage.prompt_tokens += reply.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += reply.usage?.completion_tokens ?? 0;
    fs.writeFileSync(path.join(runDir, `attempt-${n}.md`), reply.text);
    const edits = parseEdits(reply.text, task);
    const { next, problems } = applyEdits(project, task, originals, edits);
    if (!edits.length) problems.push('Your reply had no edit blocks, so nothing changed.');
    restore();
    writeFiles(project.root, next);
    verify = checkTask(project, getTask(project, id));
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    log(`Attempt ${n}: ${verify.passed ? 'passed' : 'failed'} (${secs}s, ${next.size} file${next.size === 1 ? '' : 's'} changed).`);
    if (verify.passed) {
      task = getTask(project, id);
      if (submit && !github) task = submitTask(project, id, { player: task.meta.claimed_by }).task;
      return { task, passed: true, attempts: n, usage, runDir, verify };
    }
    // Keep the conversation short for small context windows: the task, the last try, what went wrong.
    messages.splice(2, messages.length - 2, { role: 'assistant', content: reply.text }, { role: 'user', content: feedbackFor(verify, problems) });
  }
  if (!keep) restore();
  return { task: getTask(project, id), passed: false, attempts, usage, runDir, verify };
}

/** Keep taking tasks (local mode) until none are left that this player can take. */
export async function runLoop(project, opts) {
  if (project.config.workflow === 'github') {
    throw new OrchError('--loop is for local mode. In GitHub mode, /claim a task on its issue, pull, then "0rch run <task>".', 'GITHUB_MODE');
  }
  const results = [];
  const tried = new Set();
  const max = opts.maxTasks ?? Infinity;
  while (results.length < max) {
    releaseExpired(project);
    const next = claimableTasks(project, opts.player).find((t) => !tried.has(t.meta.id));
    if (!next) break;
    tried.add(next.meta.id);
    opts.log?.(`\nWorking on ${next.meta.id}: ${next.meta.title}`);
    claimTask(project, next.meta.id, opts.player);
    const res = await runTask(project, next.meta.id, { ...opts, submit: true });
    results.push(res);
    if (!res.passed) {
      // Free it for someone else, and leave a note so nobody repeats the same try blind.
      unclaimTask(project, next.meta.id, { player: opts.player, note: `${opts.model} (local) tried ${res.attempts} time${res.attempts === 1 ? '' : 's'} and didn't pass the checks.` });
      if (opts.stopOnFail) break;
    }
  }
  return results;
}
