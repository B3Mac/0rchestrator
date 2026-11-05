import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, STATE_DIR } from './project.js';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

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

/** Set up 0rchestrator files in `dir`. Existing files are left alone. */
export function initProject(dir, { name, isPrivate = false } = {}) {
  const root = path.resolve(dir);
  const projectName = name || path.basename(root);
  const files = [
    [CONFIG_FILE, '0rchestrator.yml'],
    ['GOAL.md', 'GOAL.md'],
    ['ROADMAP.md', 'ROADMAP.md'],
    ['tasks/README.md', 'tasks-README.md'],
    [`${STATE_DIR}/CONDUCTOR.md`, 'CONDUCTOR.md'],
    [`${STATE_DIR}/PLAYER.md`, 'PLAYER.md'],
  ];
  const created = [];
  const skipped = [];
  for (const [rel, tpl] of files) {
    const dest = path.join(root, rel);
    if (fs.existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    let text = fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8');
    text = text
      .replaceAll('{{name}}', JSON.stringify(projectName))
      .replaceAll('{{visibility}}', isPrivate ? 'private' : 'public')
      .replaceAll('{{private}}', isPrivate ? PRIVATE_BLOCK : '');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    created.push(rel);
  }

  const gi = path.join(root, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = IGNORE_LINES.filter((l) => !existing.split('\n').includes(l));
  if (missing.length) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gi, `${existing}${sep}# 0rchestrator: private keys and packets never leave this machine\n${missing.join('\n')}\n`);
    created.push('.gitignore (updated)');
  }
  return { root, created, skipped };
}
