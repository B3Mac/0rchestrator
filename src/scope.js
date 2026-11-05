// Scope patterns: a file ("src/a.js"), a folder ("src/" or "src"), or a glob
// ("src/**/*.js", "docs/*.md"). Paths are always relative, forward-slashed.

const GLOB_CHARS = /[*?[]/;

export function normalizePath(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function globToRegex(glob) {
  let re = '';
  const g = normalizePath(glob);
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const end = g.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += g.slice(i, end + 1);
        i = end;
      }
    } else {
      re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const SYMBOL = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * A scope entry is a file, folder or glob, optionally narrowed to one
 * function: "src/code/z_actor.c#Actor_Init" may only change Actor_Init.
 */
export function splitScope(entry) {
  const s = normalizePath(entry);
  const i = s.lastIndexOf('#');
  if (i > 0 && s[i - 1] !== '/' && SYMBOL.test(s.slice(i + 1))) return { path: s.slice(0, i), symbol: s.slice(i + 1) };
  return { path: s, symbol: null };
}

function pathMatches(f, p) {
  if (!p) return false;
  if (GLOB_CHARS.test(p)) return globToRegex(p).test(f);
  const dir = p.replace(/\/$/, '');
  return f === dir || f.startsWith(dir + '/');
}

/** Does `file` fall inside any of the scope `patterns`? */
export function matchesScope(file, patterns = []) {
  const f = normalizePath(file);
  return patterns.some((raw) => pathMatches(f, splitScope(raw).path));
}

/**
 * The functions `file` is limited to, or null when the whole file is in scope
 * (or it isn't in scope at all).
 */
export function symbolsFor(file, patterns = []) {
  const f = normalizePath(file);
  const hits = patterns.map(splitScope).filter((e) => pathMatches(f, e.path));
  if (!hits.length || hits.some((e) => !e.symbol)) return null;
  return [...new Set(hits.map((e) => e.symbol))];
}

/** Every function named in a scope, in order. */
export function scopeSymbols(patterns = []) {
  return patterns.map(splitScope).filter((e) => e.symbol);
}

/** The literal folder/file part of a pattern before any glob character. */
export function staticPrefix(pattern) {
  const p = splitScope(pattern).path;
  const idx = p.search(GLOB_CHARS);
  if (idx === -1) return p.replace(/\/$/, '');
  const head = p.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash);
}

/**
 * Could two scopes touch the same file? Conservative for globs: two globs
 * under the same folder are treated as overlapping. With `bySymbol`, two
 * different functions in the same file don't overlap (work happens in
 * separate forks and git merges them).
 */
export function scopesOverlap(a = [], b = [], { bySymbol = false } = {}) {
  for (const pa of a) {
    for (const pb of b) {
      const ea = splitScope(pa);
      const eb = splitScope(pb);
      if (bySymbol && ea.symbol && eb.symbol && ea.symbol !== eb.symbol && ea.path === eb.path) continue;
      const x = staticPrefix(pa);
      const y = staticPrefix(pb);
      if (x === '' || y === '') return true;
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
    }
  }
  return false;
}
