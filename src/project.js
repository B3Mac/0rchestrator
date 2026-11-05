import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { OrchError } from './errors.js';

export const CONFIG_FILE = '0rchestrator.yml';
export const STATE_DIR = '.0rchestrator';
export const LEDGER_FILE = 'ledger.jsonl';

export const DEFAULTS = {
  name: null,
  visibility: 'public',
  goal: 'GOAL.md',
  roadmap: 'ROADMAP.md',
  tasks_dir: 'tasks',
  // local: one checkout, packets or forks. github: tasks are issues, volunteers /claim and open PRs.
  workflow: 'local',
  // Command run before checks in a fresh checkout (GitHub mode), e.g. "npm ci".
  setup: null,
  github: {
    label: '0rchestrator',
  },
  claim_timeout_hours: 48,
  verify_timeout_seconds: 600,
  reward_unit: 'credits',
  task_types: {
    code: { verify: 'npm test' },
  },
  trust: {
    starting_score: 50,
    points: {
      accepted: { small: 8, medium: 15, large: 25 },
      reopened: -10,
      failed_submit: -3,
      scope_violation: -10,
      expired: -5,
      flagged: -50,
    },
    fences: {
      small: { min_score: 20, min_accepted: 0 },
      medium: { min_score: 40, min_accepted: 1 },
      large: { min_score: 60, min_accepted: 3 },
      sensitive: { min_score: 80, min_accepted: 5 },
      verify: { min_score: 70, min_accepted: 3 },   // may /verified someone else's PR
    },
  },
  private: {
    alias: null,
    brief: null,
    redact: [],
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `over` onto `base`. Arrays and scalars in `over` replace. */
export function mergeDeep(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

/** Walk up from `start` to the folder holding 0rchestrator.yml. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProject(start = process.cwd()) {
  const root = findRoot(start);
  if (!root) {
    throw new OrchError(
      `No ${CONFIG_FILE} found here or in any parent folder. Run "0rch init" to start a project.`,
      'NO_PROJECT',
    );
  }
  const file = path.join(root, CONFIG_FILE);
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new OrchError(`Could not read ${CONFIG_FILE}: ${err.message}`, 'BAD_CONFIG');
  }
  if (!isPlainObject(raw)) throw new OrchError(`${CONFIG_FILE} must be a YAML mapping.`, 'BAD_CONFIG');

  // task_types replaces the defaults wholesale so projects can drop "code".
  const config = mergeDeep(DEFAULTS, { ...raw, task_types: undefined });
  config.task_types = raw.task_types ?? DEFAULTS.task_types;
  config.name = config.name || path.basename(root);

  if (!['public', 'private'].includes(config.visibility)) {
    throw new OrchError(`visibility must be "public" or "private" (got "${config.visibility}").`, 'BAD_CONFIG');
  }
  if (!['local', 'github'].includes(config.workflow)) {
    throw new OrchError(`workflow must be "local" or "github" (got "${config.workflow}").`, 'BAD_CONFIG');
  }
  if (!isPlainObject(config.task_types) || Object.keys(config.task_types).length === 0) {
    throw new OrchError('task_types must define at least one task type.', 'BAD_CONFIG');
  }

  const stateDir = path.join(root, STATE_DIR);
  return {
    root,
    config,
    tasksDir: path.join(root, config.tasks_dir),
    stateDir,
    ledgerPath: path.join(stateDir, LEDGER_FILE),
  };
}

/** Relative paths that only the conductor and CLI may change. */
export function bookkeepingPaths(project) {
  return [normalizeDir(project.config.tasks_dir), STATE_DIR + '/'];
}

/** Paths a volunteer's pull request may never touch, whatever its scope says. */
export function protectedPaths(project) {
  return [...bookkeepingPaths(project), CONFIG_FILE, '.github/'];
}

export function isProtected(project, rel) {
  return protectedPaths(project).some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

function normalizeDir(p) {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  return s.endsWith('/') ? s : s + '/';
}
