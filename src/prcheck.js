import { execFileSync, spawnSync } from 'node:child_process';
import { OrchError } from './errors.js';
import { getTask, normalizeId } from './tasks.js';
import { diffNames, showFile, isGitRepo } from './git.js';
import { verifyCommandFor, runCheck, taskEnv } from './verify.js';
import { checkPullRequest, filesNeedingContents, taskIdFrom } from './github.js';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Title, branch and author of a PR via the GitHub CLI, if it's installed and signed in. */
function prInfo(root, number) {
  const r = spawnSync('gh', ['pr', 'view', String(number), '--json', 'title,headRefName,author'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { title: j.title, branch: j.headRefName, author: j.author?.login ?? null };
  } catch {
    return null;
  }
}

/**
 * Check a pull request on your own machine: scope first (without running
 * anything), then the task's full check, e.g. a decomp match that needs your
 * copy of the game. Your working tree must be clean; you're put back on your
 * branch afterwards.
 */
export function checkPrLocally(project, number, { task: givenId, remote = 'origin', run = true, log = () => {} } = {}) {
  const root = project.root;
  if (!isGitRepo(root)) throw new OrchError('This needs a git repository.', 'NO_GIT');
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new OrchError('You have uncommitted changes. Commit or stash them first, so nothing of yours gets mixed in.', 'DIRTY');
  }
  log(`Fetching PR #${number} from ${remote}…`);
  try {
    git(root, ['fetch', '-q', remote, `pull/${number}/head`]);
  } catch (err) {
    throw new OrchError(`Couldn't fetch PR #${number} from "${remote}": ${(err.stderr || err.message).toString().trim()}`, 'FETCH_FAILED');
  }
  const sha = git(root, ['rev-parse', 'FETCH_HEAD']);
  const info = givenId ? null : prInfo(root, number);
  const id = givenId ? normalizeId(givenId) : taskIdFrom(info?.title, info?.branch);
  if (!id) throw new OrchError(`Couldn't tell which task PR #${number} is for. Pass --task T-0042.`, 'USAGE');
  const task = getTask(project, id);

  const mergeBase = git(root, ['merge-base', 'HEAD', sha]);
  const files = diffNames(root, `HEAD...${sha}`);
  const text = (ref, f) => showFile(root, ref, f)?.toString('utf8') ?? null;
  const contents = new Map(filesNeedingContents(project, id, files).map((f) => [f, { before: text(mergeBase, f), after: text(sha, f) }]));
  const author = info?.author ?? task.meta.claimed_by ?? 'unknown';
  const report = checkPullRequest(project, { id, author, files, contents });
  const scopeProblems = report.reasons.filter((r) => /files|outside|Changes no|`/.test(r));
  const out = { id, sha, task, report, files, scopeOk: report.scope.passed, check: null, passed: false };
  if (!report.scope.passed || !run) return out;

  const cmd = verifyCommandFor(project, task);
  if (!cmd) {
    out.passed = true;
    return out;
  }
  const back = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).trim() || git(root, ['rev-parse', 'HEAD']);
  log(`Checking out ${sha.slice(0, 10)} and running "${cmd}"…`);
  git(root, ['checkout', '-q', '--detach', sha]);
  try {
    out.check = runCheck(cmd, { cwd: root, timeoutSeconds: project.config.verify_timeout_seconds, env: taskEnv(task) });
  } finally {
    git(root, ['checkout', '-q', back]);
  }
  out.passed = out.check.passed;
  out.scopeProblems = scopeProblems;
  return out;
}
