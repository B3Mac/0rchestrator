import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.js';
import { loadProject } from './project.js';
import { loadTasks, getTask, computeReadiness, createTask } from './tasks.js';
import { describeVerify } from './verify.js';
import { handoffPrompt, conductorPrompt, reviewPrompt } from './prompt.js';
import {
  resolvePlayer, claimTask, unclaimTask, play, submitTask, reopenTask, checkTask,
} from './ops.js';
import { statsFor } from './trust.js';

const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * Build the MCP server. Accepting work, flagging and banning are deliberately
 * NOT exposed here: those stay with a human at the CLI.
 */
export function createServer({ root = process.cwd() } = {}) {
  const server = new McpServer({ name: '0rchestrator', version: VERSION });

  const tool = (name, description, schema, fn) => {
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
      try {
        const project = loadProject(root);
        return text(await fn(project, args ?? {}));
      } catch (err) {
        if (err instanceof OrchError) return fail(err.message);
        return fail(`Unexpected error: ${err.message}`);
      }
    });
  };

  const player = z.string().optional().describe('Volunteer name, ideally your GitHub username. Defaults to $ORCH_VOLUNTEER or git user.name.');
  const taskId = z.string().describe('Task id, e.g. T-0003 or just 3');

  // ---- volunteers -----------------------------------------------------------

  tool('orch_status', 'Project name, progress, and which tasks are ready to play.', {}, (project) => {
    const tasks = loadTasks(project);
    const ready = computeReadiness(tasks);
    const counts = {};
    for (const t of tasks) counts[t.meta.status] = (counts[t.meta.status] ?? 0) + 1;
    const readyIds = tasks.filter((t) => ready.get(t.meta.id).ready).map((t) => t.meta.id);
    return JSON.stringify({ project: project.config.visibility === 'private' ? project.config.private.alias : project.config.name, total: tasks.length, counts, ready: readyIds }, null, 2);
  });

  tool('orch_list_tasks', 'List tasks with status, size, scope and whether each is ready.', { ready_only: z.boolean().optional() }, (project, { ready_only }) => {
    const tasks = loadTasks(project);
    const ready = computeReadiness(tasks);
    const rows = tasks
      .filter((t) => !ready_only || ready.get(t.meta.id).ready)
      .map((t) => ({
        id: t.meta.id, title: t.meta.title, status: t.meta.status, size: t.meta.size, type: t.meta.type,
        sensitive: t.meta.sensitive, reward: t.meta.reward ?? null, scope: t.meta.scope, claimed_by: t.meta.claimed_by ?? null,
        ready: ready.get(t.meta.id).ready, blocked_by: ready.get(t.meta.id).reasons,
      }));
    return JSON.stringify(rows, null, 2);
  });

  tool(
    'orch_play',
    'Claim the next task this volunteer is allowed to take and return its full handoff. Do the task, then call orch_verify and orch_submit.',
    { player },
    (project, args) => {
      const who = resolvePlayer(project, args.player);
      const task = play(project, who);
      if (!task) {
        const s = statsFor(project, who);
        return `Nothing ${who} can take right now (trust ${s.score}, tier ${s.tier}).`;
      }
      return `Claimed ${task.meta.id} for ${who}.\n\n${handoffPrompt(project, task)}`;
    },
  );

  tool('orch_claim', 'Claim a specific open task.', { task_id: taskId, player }, (project, args) => {
    const who = resolvePlayer(project, args.player);
    const task = claimTask(project, args.task_id, who);
    return `Claimed ${task.meta.id} for ${who}.\n\n${handoffPrompt(project, task)}`;
  });

  tool('orch_get_handoff', 'Get the handoff prompt for a task: goal, rules, scope and file contents.', { task_id: taskId }, (project, args) =>
    handoffPrompt(project, getTask(project, args.task_id)));

  tool('orch_verify', 'Check work on a task: only in-scope files changed, and its checks pass. Free to run as often as you like.', { task_id: taskId }, (project, args) =>
    describeVerify(checkTask(project, getTask(project, args.task_id))));

  tool(
    'orch_submit',
    'Hand in a claimed task. It is verified first; a failing or out-of-scope submission costs trust score, so run orch_verify before this.',
    { task_id: taskId, player },
    (project, args) => {
      const { task, result } = submitTask(project, args.task_id, { player: args.player ? resolvePlayer(project, args.player) : undefined });
      return `${describeVerify(result)}\n\n${result.passed ? `${task.meta.id} submitted for review.` : 'Not submitted. Fix the issues above and submit again.'}`;
    },
  );

  tool('orch_unclaim', 'Give a task back (for example if it is wrong or you are stuck). Explain why to the user.', { task_id: taskId, player }, (project, args) => {
    const task = unclaimTask(project, args.task_id, { player: args.player ? resolvePlayer(project, args.player) : undefined });
    return `Released ${task.meta.id}.`;
  });

  tool('orch_player', "A volunteer's trust score, tier and track record.", { player }, (project, args) => {
    const { history, ...s } = statsFor(project, resolvePlayer(project, args.player));
    return JSON.stringify(s, null, 2);
  });

  // ---- conductor ----------------------------------------------------------------

  tool('orch_plan', 'Conductor: get the planning prompt (goal, roadmap, current tasks, file tree, rules).', { batch: z.number().int().min(1).max(20).optional() }, (project, args) =>
    conductorPrompt(project, { batch: args.batch ?? 5 }));

  tool(
    'orch_new_task',
    'Conductor: create a task. Keep it small, give it a tight scope that does not overlap other open tasks, and a verify command that fails before the work.',
    {
      title: z.string(),
      type: z.string().optional(),
      size: z.enum(['small', 'medium', 'large']).optional(),
      scope: z.array(z.string()).describe('The only paths this task may change'),
      context: z.array(z.string()).optional().describe('Read-only files the volunteer should see'),
      depends_on: z.array(z.string()).optional(),
      verify: z.string().optional(),
      sensitive: z.boolean().optional(),
      reward: z.number().min(0).optional(),
      goal: z.string(),
      acceptance: z.array(z.string()).min(1),
      notes: z.string().optional(),
    },
    (project, args) => {
      const task = createTask(project, args);
      return `Created ${task.meta.id}: ${path.relative(project.root, task.path)}`;
    },
  );

  tool('orch_review', 'Conductor: get the review prompt for submitted work (diff, checks, player record).', { task_id: taskId }, (project, args) => {
    const task = getTask(project, args.task_id);
    return reviewPrompt(project, task, checkTask(project, task));
  });

  tool(
    'orch_reopen',
    'Conductor: send work back with a note on what to fix. Accepting work and flagging players are left to a human at the CLI.',
    { task_id: taskId, note: z.string() },
    (project, args) => {
      const task = reopenTask(project, args.task_id, { note: args.note, by: 'conductor' });
      return `Reopened ${task.meta.id}. A human can run "0rch accept" on good work, or "0rch flag" if something looks malicious.`;
    },
  );

  return server;
}

export async function startMcpServer({ root } = {}) {
  const server = createServer({ root });
  await server.connect(new StdioServerTransport());
}
