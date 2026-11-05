import { execFileSync } from 'node:child_process';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function isGitRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

export function headSha(root) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

export function gitUserName(root) {
  try {
    return git(root, ['config', 'user.name']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Files changed under `root` since `base`: commits made since then plus
 * anything uncommitted (staged, unstaged, untracked, deleted).
 * Paths come back relative to `root`, even when root is a subfolder of the repo.
 */
export function changedFiles(root, base) {
  const prefix = git(root, ['rev-parse', '--show-prefix']).trim();
  const files = new Set();
  const add = (p) => {
    if (!p) return;
    if (prefix && !p.startsWith(prefix)) return;
    files.add(p.slice(prefix.length));
  };

  const status = git(root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.']);
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    add(entry.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') add(parts[++i]);
  }

  const head = headSha(root);
  if (base && head && base !== head) {
    const diff = git(root, ['diff', '--name-only', '-z', base, 'HEAD', '--', '.']);
    diff.split('\0').forEach(add);
  }
  return [...files].sort();
}

/** Unified diff of `paths` (relative to root) against `base`, for review. */
export function diffAgainst(root, base, paths) {
  if (!paths.length) return '';
  const ref = base || headSha(root);
  if (!ref) return '';
  try {
    return git(root, ['diff', ref, '--', ...paths]);
  } catch {
    return '';
  }
}

/** Is a path untracked (new, never committed)? */
export function isUntracked(root, rel) {
  try {
    return git(root, ['ls-files', '--others', '--exclude-standard', '--', rel]).trim() !== '';
  } catch {
    return false;
  }
}

export function repoPrefix(root) {
  return git(root, ['rev-parse', '--show-prefix']).trim();
}

/** Fetch a branch (or HEAD) from another clone or fork. Returns the fetched commit. */
export function fetchRef(root, url, ref = 'HEAD') {
  try {
    git(root, ['fetch', '--quiet', '--no-tags', url, ref]);
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().trim();
    throw Object.assign(new Error(`Could not fetch ${ref} from ${url}: ${msg}`), { fetchFailed: true });
  }
  return git(root, ['rev-parse', 'FETCH_HEAD']).trim();
}

/** Files changed in a revision range ("a..b" or "a...b"), relative to root. */
export function diffNames(root, range) {
  const prefix = repoPrefix(root);
  return git(root, ['diff', '--name-only', '-z', range, '--', '.'])
    .split('\0')
    .filter((p) => p && p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

/** A file's bytes at a commit, or null if it does not exist there. */
export function showFile(root, commit, rel) {
  const prefix = repoPrefix(root);
  try {
    return execFileSync('git', ['show', `${commit}:${prefix}${rel}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Commit just these paths (others stay as they were). Returns the new commit or null. */
export function commitPaths(root, paths, message) {
  const added = [];
  for (const p of paths) {
    try {
      git(root, ['add', '-A', '--', p]);
      added.push(p);
    } catch {
      // Path neither on disk nor tracked: nothing to commit for it.
    }
  }
  if (!added.length) return null;
  const staged = git(root, ['diff', '--cached', '--name-only', '--', ...added]).trim();
  if (!staged) return null;
  git(root, ['commit', '-q', '-m', message, '--', ...added]);
  return headSha(root);
}

export function trackedFiles(root) {
  try {
    return git(root, ['ls-files', '-co', '--exclude-standard'])
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}
