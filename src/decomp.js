import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from './errors.js';
import { loadTasks, createTask } from './tasks.js';
import { splitScope } from './scope.js';
import { findStubs, symbolRegion } from './symbols.js';
import { projectFiles } from './prompt.js';

// Tasks for decompilation projects: one per function still written in asm
// (INCLUDE_ASM / #pragma GLOBAL_ASM), so nobody spends tokens on a function
// someone else is already matching.

const SOURCE = /\.(c|cc|cpp|cxx|inc\.c)$/i;
const SIZES = [['small', 50], ['medium', 200], ['large', Infinity]];

/** Rough instruction count of an asm file (labels, directives and comments don't count). */
export function countInstructions(text) {
  return String(text).split('\n').filter((raw) => {
    const l = raw.replace(/\/\*.*?\*\//g, '').replace(/[#;].*$/, '').trim();
    return l && !/^[\w.$]+:$/.test(l) && !/^\./.test(l) && !/^glabel\b|^endlabel\b|^dlabel\b|^jlabel\b/.test(l);
  }).length;
}

function sizeFor(count) {
  if (count === null) return 'medium';
  return SIZES.find(([, max]) => count < max)[0];
}

function sourceFiles(project, dirs) {
  const all = projectFiles(project.root).filter((f) => SOURCE.test(f));
  return dirs.length ? all.filter((f) => dirs.some((d) => f === d || f.startsWith(`${d.replace(/\/$/, '')}/`))) : all;
}

/**
 * Every function still in asm: [{ file, symbol, asm, asmExists, instructions, size, line }].
 * `asm` is the stub's .s path; it only exists after the project's setup has
 * extracted it from someone's own copy of the game.
 */
export function scanStubs(project, { dirs = [] } = {}) {
  const found = [];
  for (const file of sourceFiles(project, dirs)) {
    const text = fs.readFileSync(path.join(project.root, file), 'utf8');
    for (const stub of findStubs(text)) {
      const asmPath = stub.asm && fs.existsSync(path.join(project.root, stub.asm)) ? stub.asm : null;
      const instructions = asmPath ? countInstructions(fs.readFileSync(path.join(project.root, asmPath), 'utf8')) : null;
      found.push({ file, symbol: stub.symbol, asm: stub.asm, asmExists: Boolean(asmPath), instructions, size: sizeFor(instructions), line: stub.line });
    }
  }
  return found;
}

/** Symbols that already have a task (open, claimed, in review or done). */
function taskedSymbols(project) {
  const set = new Set();
  for (const t of loadTasks(project)) {
    for (const e of t.meta.scope.map(splitScope)) if (e.symbol) set.add(`${e.path}#${e.symbol}`);
  }
  return set;
}

const ORDER = { small: 0, medium: 1, large: 2 };

/**
 * Plan (and with `create`, make) one task per function in asm, smallest
 * first. Skips functions that already have a task.
 */
export function decompScan(project, {
  dirs = [], create = false, limit = Infinity, type = 'decomp', perFile = false, verify = null,
} = {}) {
  if (!project.config.task_types[type]) {
    throw new OrchError(`This project has no "${type}" task type. Run "0rch init --decomp", or add it to 0rchestrator.yml.`, 'BAD_CONFIG');
  }
  const stubs = scanStubs(project, { dirs });
  const tasked = taskedSymbols(project);
  const fresh = stubs.filter((s) => !tasked.has(`${s.file}#${s.symbol}`));

  let plans;
  if (perFile) {
    const byFile = new Map();
    for (const s of fresh) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    plans = [...byFile].map(([file, list]) => {
      const counted = list.filter((s) => s.instructions !== null);
      const total = counted.length === list.length ? counted.reduce((n, s) => n + s.instructions, 0) : null;
      return {
        title: `Match the ${list.length} asm function${list.length === 1 ? '' : 's'} in ${path.basename(file)}`,
        scope: list.map((s) => `${file}#${s.symbol}`),
        context: list.map((s) => s.asm).filter(Boolean),
        size: sizeFor(total),
        instructions: total,
        symbols: list.map((s) => s.symbol),
        file,
      };
    });
  } else {
    plans = fresh.map((s) => ({
      title: `Match ${s.symbol} (${path.basename(s.file)})`,
      scope: [`${s.file}#${s.symbol}`],
      context: s.asm ? [s.asm] : [],
      size: s.size,
      instructions: s.instructions,
      symbols: [s.symbol],
      file: s.file,
    }));
  }
  plans.sort((a, b) => ORDER[a.size] - ORDER[b.size] || (a.instructions ?? 1e9) - (b.instructions ?? 1e9) || a.file.localeCompare(b.file));
  const chosen = plans.slice(0, limit);

  const created = [];
  if (create) {
    for (const p of chosen) {
      const names = p.symbols.map((s) => `\`${s}\``).join(', ');
      const task = createTask(project, {
        title: p.title,
        type,
        size: p.size,
        scope: p.scope,
        context: p.context,
        verify,
        goal: `Write C for ${names} in \`${p.file}\` that compiles to exactly the same machine code as the original game, replacing ${p.symbols.length === 1 ? 'its' : 'their'} asm stub${p.symbols.length === 1 ? '' : 's'}.`,
        acceptance: [
          `The project's match check passes for ${names}`,
          `Only ${names} changes in \`${p.file}\`; every other line stays exactly as it is`,
          'No new compiler flags, pragmas or asm',
        ],
        notes: [
          `${p.instructions === null ? 'Size unknown until the asm is extracted' : `About ${p.instructions} instructions`}. The asm (${p.context.map((c) => `\`${c}\``).join(', ') || 'see the stub'}) is generated from your own copy of the game by the project's setup; it is never shared.`,
          'A good start is m2c output or a decomp.me scratch. Close but not 100%? Give it back with a note on what you tried and a decomp.me link (`/unclaim <note>` on GitHub, `0rch unclaim <id> --note "..."` locally), so the next person starts from there.',
        ].join('\n\n'),
      });
      created.push(task.meta.id);
    }
  }
  return {
    total: stubs.length,
    alreadyTasked: stubs.length - fresh.length,
    planned: plans.length,
    chosen,
    created,
    missingAsm: stubs.filter((s) => !s.asmExists).length,
  };
}

/** How much of the project is still asm, and where the tasks stand. */
export function decompProgress(project, { dirs = [] } = {}) {
  const files = sourceFiles(project, dirs);
  let stubs = 0;
  let defined = 0;
  const perFile = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(project.root, file), 'utf8');
    const fileStubs = findStubs(text).length;
    // Count C definitions: names followed by "(" whose region resolves to a definition.
    const names = new Set([...text.matchAll(/^[\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm)].map((m) => m[1]));
    const fileDefined = [...names].filter((n) => symbolRegion(text, n)?.kind === 'definition').length;
    stubs += fileStubs;
    defined += fileDefined;
    if (fileStubs + fileDefined) perFile.push({ file, asm: fileStubs, c: fileDefined });
  }
  const tasks = loadTasks(project).filter((t) => t.meta.scope.some((e) => splitScope(e).symbol));
  const by = (s) => tasks.filter((t) => t.meta.status === s).length;
  return {
    functions: stubs + defined,
    decompiled: defined,
    asm: stubs,
    percent: stubs + defined ? Math.round((defined / (stubs + defined)) * 1000) / 10 : 0,
    tasks: { open: by('open'), claimed: by('claimed'), review: by('review'), done: by('done') },
    perFile: perFile.sort((a, b) => b.asm - a.asm),
  };
}
