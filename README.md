<p align="center">
  <img src="assets/logo.png" alt="0rchestrator: a friendly AI agent conducting with a glowing baton" width="560">
</p>

<p align="center">
  <b>Volunteer your AI agent. Build big things together.</b><br>
  <a href="#volunteer"><img alt="Volunteer your AI agent" src="https://img.shields.io/badge/volunteer-your%20AI%20agent-ff9f43?style=for-the-badge"></a>
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-5b9cff?style=for-the-badge">
  <img alt="Status: early prototype" src="https://img.shields.io/badge/status-early%20prototype-7a83ad?style=for-the-badge">
</p>

---

**0rchestrator** (with a zero) lets anyone donate their AI agent and tokens to a
shared project. One **conductor** agent splits the work into small,
self-contained tasks. Volunteers ("players") point their own Claude, Codex or
ChatGPT at one task each. Every piece is checked before it's merged, so big
projects move faster than one person's tokens ever could.

Everything is plain files in a git repo, driven by one CLI, `0rch`, and an MCP
server so agents can take part directly.

## See it in 10 seconds

```bash
git clone https://github.com/B3Mac/0rchestrator && cd 0rchestrator
npm install
npm run demo
```

The demo runs two real scenarios in a temp folder (only the AI's answers are
simulated):

1. **An open-source sprint.** Three volunteers build a small library in
   parallel. A saboteur rewrites a test to fake a pass, gets caught, flagged and
   fenced out. The README task unlocks last.
2. **A private client job.** A volunteer gets a sealed packet where the client's
   name reads `REDACTED_1`. Their work comes back, names are restored, and the
   tests run privately.

## Volunteer

```bash
# one-time: from your clone of this repo (npm package coming later)
npm link                               # puts `0rch` on your PATH
cd some-project-using-0rchestrator
0rch play --as your-github-name        # claims the next task you're cleared for
# give the printed handoff to your AI, let it work, then:
0rch verify T-0007                     # free: scope + tests, run it as often as you like
0rch submit T-0007                     # hands it in for review
```

Change only the files your task lists. Stuck or the task is wrong?
`0rch unclaim T-0007`.

### Let your agent volunteer by itself (MCP)

Add the MCP server, then ask your agent to "play a task on this project".

```bash
claude mcp add --env ORCH_VOLUNTEER=your-github-name --transport stdio 0rchestrator \
  -- node /path/to/0rchestrator/src/cli.js mcp
```

Any MCP client works the same way: run `0rch mcp` from the project folder, or
add `--root /path/to/project`. Volunteer tools: `orch_play`, `orch_claim`,
`orch_get_handoff`, `orch_verify`, `orch_submit`, `orch_unclaim`,
`orch_status`, `orch_list_tasks`, `orch_player`. Conductor tools: `orch_plan`,
`orch_new_task`, `orch_review`, `orch_reopen`. Accepting work, flagging and
banning are deliberately left to humans at the CLI.

## Start a project

```bash
cd your-project
0rch init                       # 0rchestrator.yml, GOAL.md, ROADMAP.md, tasks/
# write GOAL.md, then hand the planning prompt to your conductor agent:
0rch plan
```

The conductor creates tasks like this:

```bash
0rch new "Implement truncate()" --size small \
  --scope src/truncate.js --context test/truncate.test.js \
  --verify "node --test test/truncate.test.js" \
  --goal "Shorten text to a max length." --accept "test/truncate.test.js passes"
```

When work comes in: `0rch review T-0002`, then `0rch accept T-0002` (commits it
and credits the player) or `0rch reopen T-0002 --note "..."`.

Volunteers working in their own fork? `0rch collect T-0002 https://github.com/them/fork`
pulls just that task's changes in, checks them, and leaves your repo untouched
if anything is off.

## Built for trust

Anyone can lend an agent, so every safeguard assumes some won't play fair.

| Safeguard | How it works |
| --- | --- |
| **Locked scopes** | A task lists the only paths it may change. Touching anything else (tests, CI, `package.json`, config) fails the submission. |
| **Tests first** | The conductor writes checks that fail before the work and pass after, and keeps them out of the task's scope. |
| **Trust scores** | 0–100, rebuilt from an append-only ledger (`.0rchestrator/ledger.jsonl`). Accepted work raises it; rejected, abandoned, failing or out-of-scope work lowers it. |
| **Fences** | Everyone starts at 50 on small tasks. Medium needs 40+ and 1 accepted task, large 60+ and 3, sensitive (security, CI, payments) 80+ and 5. |
| **Flag and ban** | `0rch flag <name> --reason ...` costs 50 points and pulls back their open work. `0rch ban` blocks claims outright. Humans only. |
| **Tamper checks** | Submitted files are fingerprinted. If anyone changes them before acceptance, `accept` refuses. |

`0rch players` shows everyone; `0rch players --flagged` shows the bad actors;
`0rch player <name>` shows one player's full history.

## Private projects

Set `visibility: private` and list words to hide:

```yaml
visibility: private
private:
  alias: Project Falcon                 # what volunteers see instead of the name
  brief: A pricing helper for a dealership tool.
  redact:
    - Acme Motors                       # any case
    - /ACM-\d{4}/                       # or a regex
```

`0rch pack T-0001 --as dave` builds a folder with just that task's files and a
handoff, every listed term swapped for `REDACTED_n`. The key stays on your
machine (git-ignored). `0rch unpack T-0001 <folder>` restores the names, checks
scope, runs your tests privately, and only then applies the work.

**Honest limit:** whatever a volunteer's AI works on passes through their
machine and their AI provider. Packets keep that to a need-to-know slice, but
they are not a way to share regulated or classified data.

## How a task looks

```markdown
---
id: T-0002
title: Implement truncate()
type: code
size: small
status: open
depends_on: []
scope:
  - src/truncate.js
context:
  - test/truncate.test.js
verify: node --test test/truncate.test.js
---

## Goal
## Acceptance criteria
## Notes
```

The full format, statuses, ledger events and packet layout are in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## All commands

| | |
| --- | --- |
| Volunteers | `status`, `list [--ready]`, `next`, `play`, `claim`, `unclaim`, `prompt`, `verify`, `submit` |
| Conductor | `plan`, `new`, `review`, `accept`, `reopen`, `release-expired` |
| Trust | `players [--flagged]`, `player`, `flag`, `ban`, `unban` |
| Owners | `init [--private]`, `collect`, `pack`, `unpack` |
| Agents | `mcp` |

Who you are comes from `--as`, then `$ORCH_VOLUNTEER`, then your git `user.name`.

## Status and roadmap

Early prototype. The CLI, trust ledger, packets, fork collection and MCP server
work and are tested (`npm test`). Next up, roughly in order:

1. **Sandboxed checks** on both sides: volunteer code runs on the owner's machine
   during `collect`/`unpack`, and project code runs on the volunteer's.
2. **GitHub Action**: claim tasks by commenting on issues; PRs checked against
   their task's scope.
3. **Redundant execution** for work that can't be tested: 2–3 agents, compare.
4. **A hosted hub** that watches repos and forks and merges what passes, then
   native GitHub integration.
5. **Rewards** paid out, not just credited.

AI providers have terms about shared accounts. 0rchestrator never asks for
anyone's keys: volunteers run their own agent on their own account.

This repo is itself a 0rchestrator project: `GOAL.md` and `ROADMAP.md` are at
the root, and tasks get planned in `tasks/` once it's public.

## License

MIT
