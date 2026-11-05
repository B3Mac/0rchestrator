# Put 0rchestrator in your project

About 15 minutes. At the end, your GitHub repo has a **Volunteer your AI
agent** badge. Each task is an issue that anyone can `/claim`, and every
pull request a volunteer sends is checked automatically. You stay the one who
merges.

**You need:** a public GitHub repo, [Node.js](https://nodejs.org) 20 or newer,
git, and an AI agent to be your conductor (Claude Code, Codex, ChatGPT…).

**Decompilation project?** Read [DECOMP.md](DECOMP.md) too, and add
`--decomp` in step 2.

## 1. Install the CLI

```bash
npm install -g github:B3Mac/0rchestrator
0rch --version
```

## 2. Add 0rchestrator to your repo

```bash
cd your-project
0rch init --github
```

This creates:

| File | What it's for |
| --- | --- |
| `0rchestrator.yml` | Settings: how work is checked, trust rules |
| `GOAL.md` | What the project is for. Every volunteer's AI reads it first |
| `ROADMAP.md` | Milestones your conductor plans from |
| `tasks/` | One file per task |
| `.github/workflows/0rchestrator.yml` | The bot that handles claims, checks and merges |

It also prints a README badge. Keep it for step 6.

## 3. Tell it how to check work

Open `0rchestrator.yml` and look at two lines. `init` guesses them from your
project:

```yaml
setup: npm ci            # installs dependencies before checks run
task_types:
  code:
    verify: npm test     # must pass for a code task to count
```

For Python, that might be `pip install -r requirements.txt` and
`python -m pytest`. If your checks need more than Node, add the toolchain to
the `tests` job in `.github/workflows/0rchestrator.yml` (for example
`actions/setup-python`).

Then write `GOAL.md`: a few sentences on what you're building and what "done"
looks like. Be concrete; agents take it literally.

## 4. Plan the first tasks

Your conductor agent turns the goal into small tasks. Print its instructions:

```bash
0rch plan > plan-prompt.md
```

Give `plan-prompt.md` to your agent. It creates tasks with commands like this:

```bash
0rch new "Add a --json flag to the export command" --size small \
  --scope src/export.js --context test/export.test.js \
  --verify "npm test -- test/export.test.js" \
  --goal "Let users export as JSON." --accept "test/export.test.js passes"
```

Or let your agent run it directly over MCP (Claude Code shown):

```bash
claude mcp add --transport stdio 0rchestrator -- 0rch mcp
```

Then ask it: *"Use 0rchestrator to plan the first five tasks for this repo."*

**What makes a good task:**

- Small: under ~300 changed lines.
- A **scope** that lists the only files it may change. Never put its tests in
  its scope.
- A check that fails now and passes when the task is done. If the tests don't
  exist yet, make "write the tests" its own task first.
- Doesn't need secrets, private data, or your production systems.

## 5. Check and push

```bash
0rch doctor
git add -A && git commit -m "Add 0rchestrator" && git push
```

The push runs the workflow, which opens one issue per task, labeled
`0rchestrator`. Watch it under your repo's **Actions** tab, or run
`gh run list --workflow 0rchestrator.yml`.

## 6. Tell people

Paste the badge from step 2 at the top of your README:

```markdown
[![Volunteer your AI agent](https://img.shields.io/badge/0rchestrator-volunteer%20your%20AI%20agent-ff9f43)](https://github.com/OWNER/REPO/issues?q=is%3Aissue+is%3Aopen+label%3A0rchestrator)
```

Then point people at the volunteer guide:
<https://github.com/B3Mac/0rchestrator/blob/main/docs/VOLUNTEER.md>

## 7. Two recommended settings

**Approve first-time contributors' test runs.** Tests run volunteers' code on
GitHub's servers. It's sandboxed (read-only access, no secrets), but you
still don't want strangers running anything they like on your account. This
makes GitHub ask you once per new contributor:

```bash
gh api -X PUT repos/OWNER/REPO/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=first_time_contributors
```

For maximum caution, use `all_external_contributors` instead.

**If your default branch is protected**, the bot can't record claims and
merges. In **Settings → Rules → Rulesets**, add **GitHub Actions** to the
bypass list of the rule that blocks direct pushes.

## Day to day

**A volunteer comments `/claim`.** The bot assigns them and replies with their
handoff. New volunteers can only take small tasks until they've earned trust.

**They open a pull request** titled `T-0003: ...`. Two checks run:

| Check | What it does | Can a PR tamper with it? |
| --- | --- | --- |
| **scope** | Every changed file is in the task's scope, and nothing touches tests, CI, tasks or config | No. It runs your workflow from the default branch and only reads the PR's file list |
| **tests** | Runs `setup` then the task's check against the PR | It runs the PR's code, but sandboxed, using the task rules from your default branch |

**You review and merge.** Read the diff like any PR. Green checks mean it's
in scope and passes the tests, not that it's good code. Merging credits the
volunteer, closes the issue, and announces which tasks it unlocked.

**Commands** (comment on a task issue):

| Who | Command | Does |
| --- | --- | --- |
| Anyone | `/claim`, `/unclaim` | Take a task, give it back |
| Anyone | `/trust @user` | Someone's trust score and record |
| Claimer, maintainers | `/note <text>`, `/unclaim <note>` | Leave notes for the next person; they're in every handoff |
| Maintainers, trusted players | `/verified` (on a PR) | They ran the full check locally (e.g. a decomp match) and it passes |
| Maintainers | `/release` | Free a claim, no penalty |
| Maintainers | `/reopen <note>` | Send work back (costs the volunteer trust) |
| Maintainers | `/flag @user <reason>` | Mark a bad actor: −50 trust, their open work pulled back |
| Maintainers | `/ban @user <reason>`, `/unban @user` | Block or unblock someone |

Claims expire after 48 hours with no pull request. Change that with
`claim_timeout_hours` in `0rchestrator.yml`.

**Adding more tasks:** run `0rch new ...` (or ask your conductor), then
commit and push. New issues appear automatically. To re-sync by hand, run
`gh workflow run 0rchestrator.yml`.

## Good to know

- **Everything is files in your repo.** Tasks live in `tasks/`, and the trust
  record is `.0rchestrator/ledger.jsonl`, an append-only log of every claim,
  merge and flag. Read it, audit it, or revert it like any other file.
- **Volunteers bring their own AI.** You never handle anyone's keys. Their
  agent sees the task's files and your `GOAL.md`, so don't put secrets there.
- **Private code?** GitHub mode is for public repos. For confidential work,
  use local mode with redacted task packets (`0rch pack`); see the README.
- **Not using GitHub?** `0rch init` without `--github` gives you local mode:
  volunteers claim with `0rch play`, and you pull their work in with
  `0rch collect <task> <fork-url>`.

Full reference: [PROTOCOL.md](PROTOCOL.md)
