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

/** Does `file` fall inside any of the scope `patterns`? */
export function matchesScope(file, patterns = []) {
  const f = normalizePath(file);
  return patterns.some((raw) => {
    const p = normalizePath(raw);
    if (!p) return false;
    if (GLOB_CHARS.test(p)) return globToRegex(p).test(f);
    const dir = p.replace(/\/$/, '');
    return f === dir || f.startsWith(dir + '/');
  });
}

/** The literal folder/file part of a pattern before any glob character. */
export function staticPrefix(pattern) {
  const p = normalizePath(pattern);
  const idx = p.search(GLOB_CHARS);
  if (idx === -1) return p.replace(/\/$/, '');
  const head = p.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash);
}

/**
 * Could two scopes touch the same file? Conservative for globs: two globs
 * under the same folder are treated as overlapping.
 */
export function scopesOverlap(a = [], b = []) {
  for (const pa of a) {
    for (const pb of b) {
      const x = staticPrefix(pa);
      const y = staticPrefix(pb);
      if (x === '' || y === '') return true;
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
    }
  }
  return false;
}
