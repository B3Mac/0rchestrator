import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE = path.join(REPO, 'examples', 'textkit');
export const CLI = path.join(REPO, 'src', 'cli.js');

export function tmpDir(name = 'orch') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function initRepo(dir, user = 'owner') {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', user);
  git(dir, 'config', 'user.email', `${user}@example.com`);
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

/** A fresh git copy of the textkit example. */
export function textkit() {
  const dir = tmpDir('textkit');
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  initRepo(dir);
  return { dir, project: loadProject(dir) };
}

export function write(dir, rel, text) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

export function cli(dir, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

export { SOLUTIONS } from '../examples/demo-solutions.js';
