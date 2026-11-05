import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, bookkeepingPaths } from './project.js';
import { changedFiles, isGitRepo } from './git.js';
import { matchesScope } from './scope.js';

const OUTPUT_TAIL = 4000;

/** Run one shell command as a check. Never throws for a failing command. */
export function runCheck(cmd, { cwd, timeoutSeconds = 600, env = {} } = {}) {
  // If 0rch itself runs under `node --test`, don't let that leak into the project's own test run.
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const run = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    env: { ...base, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const timedOut = run.error?.code === 'ETIMEDOUT';
  return {
    ran: true,
    cmd,
    exit_code: run.status,
    timed_out: timedOut,
    passed: run.status === 0 && !timedOut,
    output: output.length > OUTPUT_TAIL ? '…' + output.slice(-OUTPUT_TAIL) : output,
  };
}

export function verifyCommandFor(project, task) {
  if (task.meta.verify) return task.meta.verify;
  const type = project.config.task_types[task.meta.type];
  return type?.verify ?? null;
}

/**
 * Check a task's work: (1) only files inside its scope changed, (2) its
 * verify command passes. Returns a result object; never throws for a failed check.
 */
export function verifyTask(project, task, { runCommand = true, changed: given = null, exempt = () => false } = {}) {
  const result = { task: task.meta.id, scope: null, command: null, passed: false };

  if (given || isGitRepo(project.root)) {
    const ignored = bookkeepingPaths(project);
    const changed = (given ?? changedFiles(project.root, task.meta.base)).filter(
      (f) => !ignored.some((dir) => f.startsWith(dir)) && !exempt(f),
    );
    const protectedHits = changed.filter((f) => f === CONFIG_FILE);
    const outside = changed.filter((f) => !matchesScope(f, task.meta.scope) && f !== CONFIG_FILE);
    const inside = changed.filter((f) => matchesScope(f, task.meta.scope) && f !== CONFIG_FILE);
    result.scope = {
      checked: true,
      changed,
      inside,
      outside: [...protectedHits, ...outside],
      empty: inside.length === 0,
      passed: protectedHits.length === 0 && outside.length === 0 && inside.length > 0,
    };
  } else {
    result.scope = { checked: false, passed: true, reason: 'Not a git repository, so changed files could not be checked.' };
  }

  const cmd = verifyCommandFor(project, task);
  if (!cmd) {
    result.command = { ran: false, passed: true, reason: `No verify command for "${task.meta.type}" tasks. A reviewer checks this work.` };
  } else if (!runCommand) {
    result.command = { ran: false, passed: true, cmd, reason: 'Skipped.' };
  } else {
    result.command = runCheck(cmd, {
      cwd: project.root,
      timeoutSeconds: project.config.verify_timeout_seconds,
      env: { ORCH_TASK: task.meta.id },
    });
  }

  result.passed = Boolean(result.scope.passed && result.command.passed);
  return result;
}

export function describeVerify(result) {
  const lines = [];
  const s = result.scope;
  if (s.tampered?.length) lines.push(`Scope: FAILED. Changed since it was submitted:\n${s.tampered.map((f) => `  - ${f}`).join('\n')}`);
  else if (!s.checked) lines.push(`Scope: not checked. ${s.reason}`);
  else if (s.outside.length) lines.push(`Scope: FAILED. Changed outside this task's scope:\n${s.outside.map((f) => `  - ${f}`).join('\n')}`);
  else if (s.empty) lines.push('Scope: FAILED. No changes found inside the task scope.');
  else lines.push(`Scope: ok (${s.inside.length} file${s.inside.length === 1 ? '' : 's'} changed, all in scope)`);

  const c = result.command;
  if (!c.ran) lines.push(`Checks: ${c.reason}`);
  else if (c.timed_out) lines.push(`Checks: FAILED. "${c.cmd}" timed out.`);
  else lines.push(`Checks: ${c.passed ? 'ok' : 'FAILED'} ("${c.cmd}" exited ${c.exit_code})`);
  if (c.ran && !c.passed && c.output) lines.push(c.output.trimEnd());

  lines.push(result.passed ? 'Result: PASSED' : 'Result: FAILED');
  return lines.join('\n');
}
