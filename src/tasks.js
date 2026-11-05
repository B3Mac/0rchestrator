import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { OrchError } from './errors.js';
import { normalizePath, scopesOverlap } from './scope.js';

export const STATUSES = ['open', 'claimed', 'review', 'done', 'blocked'];
export const SIZES = ['small', 'medium', 'large'];
export const ACTIVE = ['claimed', 'review'];

const KEY_ORDER = [
  'id', 'title', 'type', 'size', 'status', 'sensitive', 'reward',
  'depends_on', 'scope', 'context', 'verify',
  'claimed_by', 'claimed_at', 'base', 'submitted_at', 'submitted_files', 'completed_at',
];
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** "1", "t1", "T-1", "T-0001" → "T-0001". Anything else is upper-cased as-is. */
export function normalizeId(id) {
  const s = String(id ?? '').trim();
  const m = s.match(/^(?:t-?)?(\d+)$/i);
  return m ? `T-${m[1].padStart(4, '0')}` : s.toUpperCase();
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

function list(v) {
  if (v === null || v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

export function parseTask(text, file = '<task>') {
  const m = text.match(FM);
  if (!m) throw new OrchError(`${file}: missing the --- front matter block at the top.`, 'BAD_TASK');
  let meta;
  try {
    meta = YAML.parse(m[1]) ?? {};
  } catch (err) {
    throw new OrchError(`${file}: front matter is not valid YAML (${err.message}).`, 'BAD_TASK');
  }
  if (!meta.id) throw new OrchError(`${file}: front matter needs an "id".`, 'BAD_TASK');
  if (!meta.title) throw new OrchError(`${file}: front matter needs a "title".`, 'BAD_TASK');
  meta.id = normalizeId(meta.id);
  meta.status = meta.status ?? 'open';
  meta.size = meta.size ?? 'small';
  meta.type = meta.type ?? 'code';
  if (!STATUSES.includes(meta.status)) {
    throw new OrchError(`${file}: status must be one of ${STATUSES.join(', ')} (got "${meta.status}").`, 'BAD_TASK');
  }
  if (!SIZES.includes(meta.size)) {
    throw new OrchError(`${file}: size must be one of ${SIZES.join(', ')} (got "${meta.size}").`, 'BAD_TASK');
  }
  meta.depends_on = list(meta.depends_on).map(normalizeId);
  meta.scope = list(meta.scope).map(normalizePath);
  meta.context = list(meta.context).map(normalizePath);
  meta.sensitive = Boolean(meta.sensitive);
  return { meta, body: m[2].replace(/^\n+/, ''), file };
}

export function serializeTask(task) {
  const ordered = {};
  for (const k of KEY_ORDER) {
    const v = task.meta[k];
    if (v === undefined || v === null) continue;
    if (k === 'sensitive' && v === false) continue;
    ordered[k] = v;
  }
  for (const [k, v] of Object.entries(task.meta)) {
    if (!(k in ordered) && !KEY_ORDER.includes(k) && v !== undefined && v !== null) ordered[k] = v;
  }
  const fm = YAML.stringify(ordered, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n\n${task.body.trimEnd()}\n`;
}

export function loadTasks(project) {
  if (!fs.existsSync(project.tasksDir)) return [];
  const files = fs
    .readdirSync(project.tasksDir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
  const seen = new Map();
  const tasks = files.map((f) => {
    const full = path.join(project.tasksDir, f);
    const task = parseTask(fs.readFileSync(full, 'utf8'), path.join(project.config.tasks_dir, f));
    task.path = full;
    if (seen.has(task.meta.id)) {
      throw new OrchError(`Task id ${task.meta.id} is used twice (${seen.get(task.meta.id)} and ${f}).`, 'BAD_TASK');
    }
    seen.set(task.meta.id, f);
    return task;
  });
  return tasks.sort((a, b) => a.meta.id.localeCompare(b.meta.id, 'en', { numeric: true }));
}

export function getTask(project, id, tasks = loadTasks(project)) {
  const want = normalizeId(id);
  const task = tasks.find((t) => t.meta.id === want);
  if (!task) throw new OrchError(`No task ${want}. Run "0rch list" to see tasks.`, 'NO_TASK');
  return task;
}

export function saveTask(task) {
  fs.writeFileSync(task.path, serializeTask(task));
}

export function nextId(tasks) {
  const nums = tasks.map((t) => Number((t.meta.id.match(/^T-(\d+)$/) || [])[1] || 0));
  return normalizeId(String(Math.max(0, ...nums) + 1));
}

/**
 * For each task: can someone start it right now?
 * Open + every dependency done + no overlap with a task already in progress.
 */
export function computeReadiness(tasks) {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  const active = tasks.filter((t) => ACTIVE.includes(t.meta.status));
  const out = new Map();
  for (const t of tasks) {
    const reasons = [];
    if (t.meta.status !== 'open') {
      out.set(t.meta.id, { ready: false, reasons: [`status is ${t.meta.status}`] });
      continue;
    }
    for (const dep of t.meta.depends_on) {
      const d = byId.get(dep);
      if (!d) reasons.push(`depends on unknown task ${dep}`);
      else if (d.meta.status !== 'done') reasons.push(`waiting on ${dep}`);
    }
    for (const a of active) {
      if (a !== t && scopesOverlap(t.meta.scope, a.meta.scope)) {
        reasons.push(`scope overlaps ${a.meta.id}, which is in progress`);
      }
    }
    out.set(t.meta.id, { ready: reasons.length === 0, reasons });
  }
  return out;
}

export function newTaskBody({ goal, acceptance = [], notes } = {}) {
  const crit = acceptance.length ? acceptance.map((a) => `- ${a}`).join('\n') : '- TODO: how we know it is done';
  return [
    '## Goal',
    '',
    goal || 'TODO: what this task should achieve, in a few sentences.',
    '',
    '## Acceptance criteria',
    '',
    crit,
    '',
    '## Notes',
    '',
    notes || '_None yet._',
    '',
  ].join('\n');
}

export function createTask(project, opts) {
  const tasks = loadTasks(project);
  if (!opts.title) throw new OrchError('A task needs a title.', 'BAD_TASK');
  const type = opts.type || Object.keys(project.config.task_types)[0];
  if (!project.config.task_types[type]) {
    throw new OrchError(
      `Unknown task type "${type}". This project defines: ${Object.keys(project.config.task_types).join(', ')}.`,
      'BAD_TASK',
    );
  }
  const size = opts.size || 'small';
  if (!SIZES.includes(size)) throw new OrchError(`size must be one of ${SIZES.join(', ')}.`, 'BAD_TASK');
  const id = nextId(tasks);
  const depends = list(opts.depends_on).map(normalizeId);
  for (const d of depends) {
    if (!tasks.some((t) => t.meta.id === d)) throw new OrchError(`depends_on: no task ${d}.`, 'BAD_TASK');
  }
  const meta = {
    id,
    title: String(opts.title),
    type,
    size,
    status: 'open',
    sensitive: Boolean(opts.sensitive),
    reward: opts.reward === undefined || opts.reward === null || opts.reward === '' ? null : Number(opts.reward),
    depends_on: depends,
    scope: list(opts.scope).map(normalizePath),
    context: list(opts.context).map(normalizePath),
    verify: opts.verify || null,
  };
  if (meta.reward !== null && !(meta.reward >= 0)) throw new OrchError('reward must be a number ≥ 0.', 'BAD_TASK');
  fs.mkdirSync(project.tasksDir, { recursive: true });
  const file = path.join(project.tasksDir, `${id}-${slugify(meta.title)}.md`);
  const task = { meta, body: newTaskBody(opts), path: file };
  saveTask(task);
  return task;
}

/** Append a dated note under "## Review notes" in the task body. */
export function addNote(task, text, who, now = new Date()) {
  const line = `- ${now.toISOString().slice(0, 10)}${who ? ` (${who})` : ''}: ${text}`;
  if (/^## Review notes\s*$/m.test(task.body)) task.body = task.body.trimEnd() + '\n' + line + '\n';
  else task.body = task.body.trimEnd() + '\n\n## Review notes\n\n' + line + '\n';
}

export function clearClaim(meta) {
  meta.claimed_by = null;
  meta.claimed_at = null;
  meta.base = null;
  meta.submitted_at = null;
  meta.submitted_files = null;
}
