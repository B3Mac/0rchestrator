import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CONFIG_FILE, STATE_DIR } from './project.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, 'templates');
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
export const WORKFLOW_FILE = '.github/workflows/0rchestrator.yml';

const PRIVATE_BLOCK = `
# Private projects: what volunteers see instead of the real name and goal,
# and words to swap for placeholders in every packet. Literal words match
# any case; /regex/flags works too.
private:
  alias: Project X
  brief: A short, non-identifying description of what the work is for.
  redact:
    - Example Client Name
    - /sk-[A-Za-z0-9]{20,}/
`;

const IGNORE_LINES = [`${STATE_DIR}/redactions/`, `${STATE_DIR}/packets/`];

function gitOut(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** "owner/name" from the origin remote, if it points at GitHub. */
export function githubSlug(root) {
  const url = gitOut(root, ['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function badgeMarkdown(slug, label = '0rchestrator') {
  const issues = slug
    ? `https://github.com/${slug}/issues?q=is%3Aissue+is%3Aopen+label%3A${encodeURIComponent(label)}`
    : 'https://github.com/OWNER/REPO/issues?q=is%3Aissue+is%3Aopen+label%3A0rchestrator';
  return `[![Volunteer your AI agent](https://img.shields.io/badge/0rchestrator-volunteer%20your%20AI%20agent-ff9f43)](${issues})`;
}

/** Guess the project's setup and check commands from what's in the folder. */
function guessCommands(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) return { setup: has('package-lock.json') ? 'npm ci' : 'npm install', verify: 'npm test' };
  if (has('pyproject.toml') || has('requirements.txt')) {
    return { setup: has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .', verify: 'python -m pytest' };
  }
  if (has('Cargo.toml')) return { setup: null, verify: 'cargo test' };
  if (has('go.mod')) return { setup: null, verify: 'go test ./...' };
  return { setup: null, verify: 'npm test' };
}

const yamlValue = (v) => (v === null || v === undefined ? 'null' : JSON.stringify(v));

/** Set up 0rchestrator files in `dir`. Existing files are left alone. */
export function initProject(dir, { name, isPrivate = false, github = false, branch } = {}) {
  const root = path.resolve(dir);
  const projectName = name || path.basename(root);
  const guess = guessCommands(root);
  const created = [];
  const skipped = [];
  const updated = [];
  const files = [
    [CONFIG_FILE, '0rchestrator.yml'],
    ['GOAL.md', 'GOAL.md'],
    ['ROADMAP.md', 'ROADMAP.md'],
    ['tasks/README.md', 'tasks-README.md'],
    [`${STATE_DIR}/CONDUCTOR.md`, 'CONDUCTOR.md'],
    [`${STATE_DIR}/PLAYER.md`, 'PLAYER.md'],
  ];
  const mainBranch = branch || gitOut(root, ['symbolic-ref', '--short', 'HEAD']) || 'main';
  if (github) files.push([WORKFLOW_FILE, 'github-workflow.yml']);

  for (const [rel, tpl] of files) {
    const dest = path.join(root, rel);
    if (fs.existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    const text = fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8')
      .replaceAll('{{name}}', JSON.stringify(projectName))
      .replaceAll('{{visibility}}', isPrivate ? 'private' : 'public')
      .replaceAll('{{workflow}}', github ? 'github' : 'local')
      .replaceAll('{{setup}}', yamlValue(guess.setup))
      .replaceAll('{{verify}}', yamlValue(guess.verify))
      .replaceAll('{{private}}', isPrivate ? PRIVATE_BLOCK : '')
      .replaceAll('{{version}}', VERSION)
      .replaceAll('{{branch}}', mainBranch)
      .replaceAll('{{tasks_dir}}', 'tasks')
      .replaceAll('{{label}}', '0rchestrator');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    created.push(rel);
  }

  // An existing local-mode project switching to GitHub mode.
  if (github && skipped.includes(CONFIG_FILE)) {
    const file = path.join(root, CONFIG_FILE);
    const text = fs.readFileSync(file, 'utf8');
    const raw = YAML.parse(text) ?? {};
    if (raw.workflow !== 'github') {
      const next = /^workflow:.*$/m.test(text)
        ? text.replace(/^workflow:.*$/m, 'workflow: github')
        : `${text.trimEnd()}\n\n# Tasks become GitHub issues; volunteers /claim and open PRs.\nworkflow: github\n`;
      fs.writeFileSync(file, next);
      updated.push(`${CONFIG_FILE} (workflow: github)`);
    }
  }

  const gi = path.join(root, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = IGNORE_LINES.filter((l) => !existing.split('\n').includes(l));
  if (missing.length) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gi, `${existing}${sep}# 0rchestrator: private keys and packets never leave this machine\n${missing.join('\n')}\n`);
    (existing ? updated : created).push('.gitignore');
  }
  const slug = githubSlug(root);
  return { root, created, skipped, updated, slug, branch: mainBranch, badge: badgeMarkdown(slug) };
}
