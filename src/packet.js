import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.js';
import { getTask, slugify } from './tasks.js';
import { claimTask, intake } from './ops.js';
import { handoffPrompt, handoffFiles } from './prompt.js';
import { Redactor } from './redact.js';
import { playerKey } from './trust.js';
import { isGitRepo, showFile } from './git.js';

// A task packet is a folder a volunteer can work on without the repo:
//   HANDOFF.md    the prompt for their AI (redacted)
//   files/        only the files this task needs (redacted)
//   packet.json   manifest with a hash of every file as sent
// The redaction key stays in .0rchestrator/redactions/ on the owner's side.

export const PACKET_FORMAT = '0rchestrator-packet/1';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function mappingPath(project, id) {
  return path.join(project.stateDir, 'redactions', `${id}.json`);
}

function loadRedactor(project, id) {
  const file = mappingPath(project, id);
  const mapping = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return new Redactor(project.config.private.redact ?? [], mapping);
}

function walk(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) return walk(path.join(dir, ent.name), r);
    return ent.isFile() ? [r] : [];
  });
}

export function packTask(project, id, { player, out, now = new Date() } = {}) {
  let task = getTask(project, id);
  if (task.meta.status === 'open') task = claimTask(project, id, player, { now });
  else if (task.meta.status !== 'claimed' || playerKey(task.meta.claimed_by) !== playerKey(player)) {
    throw new OrchError(`${task.meta.id} is ${task.meta.status}${task.meta.claimed_by ? ` by ${task.meta.claimed_by}` : ''}; it can't be packed for ${player}.`, 'NOT_YOURS');
  }

  const dir = path.resolve(out || path.join(project.stateDir, 'packets', `${task.meta.id}-${slugify(player)}`));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (out) throw new OrchError(`${dir} already exists and is not empty.`, 'EXISTS');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const redactor = loadRedactor(project, task.meta.id);
  const manifest = {
    format: PACKET_FORMAT,
    project: project.config.visibility === 'private' ? project.config.private.alias || 'private project' : project.config.name,
    task: task.meta.id,
    title: redactor.redact(task.meta.title),
    scope: task.meta.scope.map((s) => redactor.redact(s)),
    created_at: now.toISOString(),
    files: {},
  };
  const skipped = [];
  for (const rel of handoffFiles(project, task)) {
    const src = path.join(project.root, rel);
    const buf = fs.readFileSync(src);
    if (buf.includes(0)) {
      skipped.push(rel);
      continue;
    }
    const outRel = redactor.redact(rel);
    const content = Buffer.from(redactor.redact(buf.toString('utf8')));
    const dest = path.join(dir, 'files', outRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    manifest.files[outRel] = sha(content);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'HANDOFF.md'), handoffPrompt(project, task, { mode: 'packet', redactor }));
  fs.writeFileSync(path.join(dir, 'packet.json'), JSON.stringify(manifest, null, 2) + '\n');

  fs.mkdirSync(path.dirname(mappingPath(project, task.meta.id)), { recursive: true });
  fs.writeFileSync(mappingPath(project, task.meta.id), JSON.stringify(redactor.mapping(), null, 2) + '\n');

  return { task, dir, files: Object.keys(manifest.files), redactions: Object.keys(redactor.mapping()).length, skipped };
}

export function unpackTask(project, id, dir, { player, now = new Date() } = {}) {
  const task = getTask(project, id);
  if (task.meta.status !== 'claimed') throw new OrchError(`${task.meta.id} is ${task.meta.status}; only claimed tasks take packets back.`, 'NOT_CLAIMED');
  if (player && playerKey(player) !== playerKey(task.meta.claimed_by)) {
    throw new OrchError(`${task.meta.id} was packed for ${task.meta.claimed_by}, not ${player}.`, 'NOT_YOURS');
  }
  const manifestFile = path.join(dir, 'packet.json');
  if (!fs.existsSync(manifestFile)) throw new OrchError(`${dir} has no packet.json; is this a 0rchestrator packet?`, 'BAD_PACKET');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new OrchError('packet.json is not valid JSON.', 'BAD_PACKET');
  }
  if (manifest.format !== PACKET_FORMAT) throw new OrchError(`Unknown packet format ${manifest.format}.`, 'BAD_PACKET');
  if (manifest.task !== task.meta.id) throw new OrchError(`This packet is for ${manifest.task}, not ${task.meta.id}.`, 'BAD_PACKET');

  const redactor = loadRedactor(project, task.meta.id);
  const filesDir = path.join(dir, 'files');
  // The files as they were when the packet was made, for a three-way merge.
  const startedFrom = (rel) => (task.meta.base && isGitRepo(project.root) ? showFile(project.root, task.meta.base, rel) : undefined);
  const present = walk(filesDir);
  const changes = [];
  for (const rel of present) {
    const buf = fs.readFileSync(path.join(filesDir, rel));
    if (manifest.files[rel] === sha(buf)) continue;
    const real = redactor.restore(rel);
    changes.push({ rel: real, content: Buffer.from(redactor.restore(buf.toString('utf8'))), base: startedFrom(real) });
  }
  for (const rel of Object.keys(manifest.files)) {
    if (!present.includes(rel)) changes.push({ rel: redactor.restore(rel), content: null, base: startedFrom(redactor.restore(rel)) });
  }
  for (const c of changes) {
    if (c.rel.split('/').includes('..') || path.isAbsolute(c.rel)) {
      throw new OrchError(`Packet tried to write outside the project: ${c.rel}`, 'BAD_PACKET');
    }
  }
  return intake(project, task, changes, { now });
}
