// Function-level scopes for decompilation projects.
//
// A task scoped to "src/game.c#Actor_Init" may only change the part of
// game.c that holds Actor_Init: its INCLUDE_ASM / GLOBAL_ASM stub, the
// NON_MATCHING block around it, or its C definition. Everything else in the
// file must stay byte-for-byte the same. That lets many volunteers work on
// different functions of one file at once, and git merges their PRs cleanly.

const STUB_CALL = /^\s*INCLUDE_ASM\w*\s*\((.*)\)\s*;?\s*(?:\/\/.*|\/\*.*\*\/)?\s*$/;
const PRAGMA = /^\s*#\s*pragma\s+GLOBAL_ASM\s*\(\s*"([^"]+)"\s*\)/;
const NONMATCHING_IF = /^\s*#\s*if(?:def|ndef)?\b.*\bNON_?MATCHING\b/;

/** Split text into lines that keep their offsets (and newlines). */
function lines(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ start, end, text: text.slice(start, nl === -1 ? text.length : nl) });
    start = end;
  }
  return out;
}

/** The function name and asm path in an INCLUDE_ASM(...) or #pragma GLOBAL_ASM(...) line, if any. */
export function parseStub(line) {
  const call = line.match(STUB_CALL);
  if (call && !/INCLUDE_RODATA/.test(line)) {
    const args = call[1].split(',').map((a) => a.trim());
    const symbol = args.at(-1);
    const dir = args.find((a) => /^".*"$/.test(a))?.slice(1, -1) ?? null;
    if (/^[A-Za-z_][\w$.]*$/.test(symbol)) return { symbol, asm: dir ? `${dir}/${symbol}.s` : null, kind: 'INCLUDE_ASM' };
  }
  const pragma = line.match(PRAGMA);
  if (pragma) {
    const file = pragma[1];
    const symbol = file.split('/').pop().replace(/\.s$/, '');
    return { symbol, asm: file, kind: 'GLOBAL_ASM' };
  }
  return null;
}

/**
 * Brace depth at every character. Comments, strings, char literals and
 * preprocessor lines get -1 so nothing inside them is mistaken for code.
 */
function braceDepths(text) {
  const depth = new Int32Array(text.length + 1).fill(-1);
  let d = 0;
  let i = 0;
  let lineStart = true;
  const skipTo = (stop) => {
    while (i < stop) depth[i++] = -1;
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (lineStart && (c === ' ' || c === '\t')) {
      depth[i++] = d;
      continue;
    }
    if (lineStart && c === '#') {
      let j = i;
      while (j < text.length && !(text[j] === '\n' && text[j - 1] !== '\\')) j++;
      skipTo(j);
      continue;
    }
    lineStart = c === '\n';
    if (c === '/' && n === '/') {
      const nl = text.indexOf('\n', i);
      skipTo(nl === -1 ? text.length : nl);
      continue;
    }
    if (c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      skipTo(e === -1 ? text.length : e + 2);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      skipTo(Math.min(j + 1, text.length));
      continue;
    }
    depth[i] = d;
    if (c === '{') d++;
    else if (c === '}') d = Math.max(0, d - 1);
    i++;
  }
  depth[text.length] = d;
  return depth;
}

/** Where a C function definition named `symbol` starts and ends, by line. */
function definitionRegion(text, symbol) {
  const depth = braceDepths(text);
  const re = new RegExp(`\\b${symbol.replace(/[$.]/g, '\\$&')}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (depth[m.index] !== 0) continue;
    // A definition: after the parameter list comes "{" before any ";".
    let i = m.index + m[0].length;
    let parens = 1;
    while (i < text.length && parens > 0) {
      if (depth[i] !== -1) {
        if (text[i] === '(') parens++;
        else if (text[i] === ')') parens--;
      }
      i++;
    }
    while (i < text.length && !(depth[i] === 0 && (text[i] === '{' || text[i] === ';'))) i++;
    if (text[i] !== '{') continue;
    let close = i + 1;
    while (close < text.length && !(text[close] === '}' && depth[close] === 1)) close++;
    if (close >= text.length) return null;
    // Start at the line holding the name, plus any return-type lines just above it.
    let start = text.lastIndexOf('\n', m.index) + 1;
    while (start > 0) {
      const prevStart = text.lastIndexOf('\n', start - 2) + 1;
      const prev = text.slice(prevStart, start - 1);
      const t = prev.trim();
      if (!t || /[;{}]$/.test(t) || t.startsWith('#') || t.startsWith('//') || t.endsWith('*/') || depth[prevStart + prev.search(/\S/)] !== 0) break;
      start = prevStart;
    }
    const nl = text.indexOf('\n', close);
    return { start, end: nl === -1 ? text.length : nl + 1, kind: 'definition' };
  }
  return null;
}

/** The #if/#ifdef/#ifndef ... #endif block around line `at`, if it mentions NON_MATCHING. */
function nonMatchingBlock(ls, at) {
  const isIf = (t) => /^\s*#\s*if/.test(t);
  const isEnd = (t) => /^\s*#\s*endif\b/.test(t);
  let top = -1;
  for (let j = at - 1, nest = 0; j >= 0; j--) {
    const t = ls[j].text;
    if (isEnd(t)) nest++;
    else if (isIf(t)) {
      if (nest === 0) {
        top = j;
        break;
      }
      nest--;
    }
  }
  if (top === -1 || !NONMATCHING_IF.test(ls[top].text)) return null;
  for (let j = at + 1, nest = 0; j < ls.length; j++) {
    const t = ls[j].text;
    if (isIf(t)) nest++;
    else if (isEnd(t)) {
      if (nest === 0) return { first: top, last: j };
      nest--;
    }
  }
  return null;
}

/**
 * The span of `text` that belongs to `symbol`: its asm stub (widened to a
 * surrounding `#ifdef NON_MATCHING ... #else ... #endif` block), or its C
 * definition. Offsets are whole lines. Null if the symbol isn't there.
 */
export function symbolRegion(text, symbol) {
  const ls = lines(text);
  const at = ls.findIndex((l) => parseStub(l.text)?.symbol === symbol);
  if (at !== -1) {
    // #if NON_MATCHING <C attempt> #else <stub> #endif (either order) → the whole block.
    const block = nonMatchingBlock(ls, at);
    if (block) return { start: ls[block.first].start, end: ls[block.last].end, kind: 'NON_MATCHING' };
    return { start: ls[at].start, end: ls[at].end, kind: parseStub(ls[at].text).kind };
  }
  return definitionRegion(text, symbol);
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

const norm = (t) => String(t).replace(/\r\n/g, '\n');

/**
 * Did `after` change only the regions of `symbols` in `before`?
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkSymbolChange(before, after, symbols) {
  if (before === null || before === undefined) return { ok: false, reason: 'is a new file, but this task may only change existing functions in it' };
  if (after === null || after === undefined) return { ok: false, reason: 'was deleted, but this task may only change functions in it' };
  const base = norm(before);
  const next = norm(after);
  const regions = [];
  for (const s of symbols) {
    const r = symbolRegion(base, s);
    if (!r) return { ok: false, reason: `doesn't contain ${s} in the original, so it can't be checked` };
    regions.push(r);
  }
  regions.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of regions) {
    const prev = merged.at(-1);
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end);
    else merged.push({ ...r });
  }
  const segments = [];
  let cursor = 0;
  for (const r of merged) {
    segments.push(base.slice(cursor, r.start));
    cursor = r.end;
  }
  segments.push(base.slice(cursor));

  const names = symbols.join(', ');
  const outside = (where) => ({ ok: false, reason: `changes code outside ${names} (around line ${lineOf(next, where)})` });
  const head = segments[0];
  if (!next.startsWith(head)) {
    let i = 0;
    while (i < head.length && head[i] === next[i]) i++;
    return outside(i);
  }
  let pos = head.length;
  for (const seg of segments.slice(1, -1)) {
    const idx = next.indexOf(seg, pos);
    if (idx === -1) return outside(pos);
    pos = idx + seg.length;
  }
  const tail = segments.at(-1);
  if (segments.length > 1 && (!next.endsWith(tail) || next.length - tail.length < pos)) {
    let i = 0;
    while (i < tail.length && tail[tail.length - 1 - i] === next[next.length - 1 - i]) i++;
    return outside(next.length - i);
  }
  return { ok: true };
}

/** Every asm stub in a C file: [{ symbol, asm, kind, line }]. */
export function findStubs(text) {
  return lines(norm(text))
    .map((l, i) => ({ ...parseStub(l.text), line: i + 1 }))
    .filter((s) => s.symbol);
}
