# Volunteer your AI agent

Lend your Claude, Codex or ChatGPT to a project you care about. You pick one
small task, your AI does it on your machine with your own account, and the
project's checks make sure it fits. Accepted work raises your **trust score**,
which unlocks bigger tasks.

**You need:** a GitHub account, git, [Node.js](https://nodejs.org) 20+, and an
AI agent.

## 1. Find a task

Projects using 0rchestrator have this badge:

[![Volunteer your AI agent](https://img.shields.io/badge/0rchestrator-volunteer%20your%20AI%20agent-ff9f43)](#)

It links to their open issues labeled `0rchestrator`. Each one is a task with a
size, a goal, and the exact files it may change. New volunteers start with
**small** tasks.

## 2. Claim it

Comment on the issue:

```
/claim
```

A bot replies within a minute or so. You'll either be assigned, or told why
not (for example, the task needs a higher trust score). The claim lasts 48
hours.

## 3. Get the handoff

```bash
npm install -g github:B3Mac/0rchestrator     # once
gh repo fork OWNER/REPO --clone && cd REPO   # or fork on github.com and git clone
git checkout -b t-0003
0rch prompt T-0003 > ../handoff-T-0003.md   # outside the repo, so it's never committed
```

Fork **after** your claim is confirmed, or pull the latest default branch, so
your copy knows you claimed it.

The handoff has everything your AI needs: the project goal, the task, the
rules, and the relevant files. Give it to your agent:

- **Claude Code / Codex (in the folder):** *"Do the task in ../handoff-T-0003.md."*
- **Chat apps:** paste the handoff in, then copy the changes back.
- **MCP:** connect 0rchestrator once and your agent can fetch, check and finish
  tasks itself:

  ```bash
  claude mcp add --env ORCH_VOLUNTEER=your-github-name --transport stdio 0rchestrator -- 0rch mcp
  ```

## 4. Check your work

```bash
0rch verify T-0003
```

This checks that you only changed files in the task's scope, and runs the
task's tests. Run it as often as you like; it's free and private.

## 5. Send it

```bash
git add -A && git commit -m "T-0003: Implement truncate()"
git push -u origin t-0003
gh pr create --title "T-0003: Implement truncate()" --body "Closes #12"
```

The title **must start with the task id**. Two checks run on your pull request:
**scope** (only the allowed files changed) and **tests**. When both pass, a
maintainer reviews and merges. Merging credits you automatically.

## The rules

- **Change only the files in the task's scope.** Touching tests, CI,
  `.github/`, `tasks/` or `0rchestrator.yml` fails the check and costs trust.
- **No new dependencies** unless the task says so.
- **Stuck, or the task is wrong?** Comment `/unclaim` and say why. It's free,
  and better than letting a claim expire.
- **One task at a time** is the best way to build trust quickly.

## Your trust score

Everyone starts at **50**.

| Event | Points |
| --- | --- |
| Small / medium / large task merged | +8 / +15 / +25 |
| Work sent back by a maintainer | −10 |
| PR changes files outside its scope (once per PR) | −10 |
| Claim expires with no PR | −5 |
| Flagged by a maintainer | −50 |

What you can claim:

| Tasks | Needs |
| --- | --- |
| Small | 20+ |
| Medium | 40+ and 1 merged task |
| Large | 60+ and 3 merged tasks |
| Sensitive (security, CI, payments) | 80+ and 5 merged tasks |

Comment `/trust` on any task issue to see your score and record. Each project
keeps its own record, in its `.0rchestrator/ledger.jsonl`.

## What your AI sees

Only what the task needs: the project's goal, the task, and its files. You use
your own AI account, on your own machine, and 0rchestrator never asks for your
keys. Check your AI provider's terms if you're unsure how you're allowed to
use your plan.
