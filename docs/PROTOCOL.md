# The 0rchestrator protocol (v0.3)

Any git repo that follows this layout can take volunteers. The `0rch` CLI and
MCP server implement it; nothing else is required.

## Files

| Path | Who writes it | What it is |
| --- | --- | --- |
| `0rchestrator.yml` | Owner | Project settings (below) |
| `GOAL.md` | Owner | What the project is for and what "done" means |
| `ROADMAP.md` | Conductor | Ordered milestones |
| `tasks/T-0001-*.md` | Conductor, CLI | One file per task |
| `.0rchestrator/ledger.jsonl` | CLI | Append-only log of every claim, submission, review and moderation action |
| `.0rchestrator/CONDUCTOR.md`, `PLAYER.md` | Owner | Instructions for agents |
| `.0rchestrator/redactions/` | CLI | Private: redaction keys. Git-ignored, never shared |
| `.0rchestrator/packets/` | CLI | Private: packets built for volunteers. Git-ignored |
| `.github/workflows/0rchestrator.yml` | Owner (`init --github`) | GitHub mode: the bot |

Volunteers never edit `tasks/` or `.0rchestrator/` by hand. In fork and packet
mode, changes there are ignored; in a shared tree they are bookkeeping written
by the CLI.

## 0rchestrator.yml

```yaml
name: textkit
visibility: public            # or private
workflow: local               # or github: tasks are issues, work arrives as PRs
setup: null                   # command run before checks in a fresh checkout, e.g. npm ci
github:
  label: 0rchestrator         # label on task issues
goal: GOAL.md
roadmap: ROADMAP.md
tasks_dir: tasks
claim_timeout_hours: 48
verify_timeout_seconds: 600
reward_unit: credits
task_types:                   # each type says how its work is checked
  code: { verify: npm test }
  docs: { verify: null }      # null = a reviewer reads it
trust:
  starting_score: 50
  points:
    accepted: { small: 8, medium: 15, large: 25 }
    reopened: -10
    failed_submit: -3
    scope_violation: -10
    expired: -5
    flagged: -50
  fences:                     # what it takes to claim each kind of task
    small:     { min_score: 20, min_accepted: 0 }
    medium:    { min_score: 40, min_accepted: 1 }
    large:     { min_score: 60, min_accepted: 3 }
    sensitive: { min_score: 80, min_accepted: 5 }
private:                      # only used when visibility is private
  alias: Project Falcon
  brief: One non-identifying sentence about the work.
  redact: [Acme Motors, "/ACM-\\d{4}/"]
```

Every key is optional; these are the defaults.

## Tasks

A task is Markdown with YAML front matter:

| Field | Meaning |
| --- | --- |
| `id` | `T-0001`. Unique. `1`, `t1` and `T-1` all mean `T-0001` on the command line |
| `title` | Short, imperative |
| `type` | A key of `task_types` |
| `size` | `small` · `medium` · `large` (~under 300 changed lines for small) |
| `status` | `open` · `claimed` · `review` · `done` · `blocked` |
| `sensitive` | `true` for security, CI, auth, secrets, payments, dependencies or infrastructure |
| `reward` | Optional number, credited on acceptance |
| `depends_on` | Task ids that must be `done` first |
| `scope` | The only paths this task may create, change or delete. Files, folders (`src/`) or globs (`src/**/*.js`). `file#Name` limits a file to one function (see below) |
| `context` | Read-only files shown to the volunteer's AI |
| `verify` | Optional command that overrides the type's. `{task}`, `{symbol}`, `{symbols}` and `{file}` are filled in |
| `ci`, `ci_verify` | Optional overrides of the type's (see "Checks CI can't run") |
| `claimed_by`, `claimed_at`, `base` | Set on claim (`base` = the commit the work starts from) |
| `submitted_at`, `submitted_files` | Set on submit (`submitted_files` = a sha256 of each submitted file) |
| `completed_at` | Set on accept |
| `pr` | GitHub mode: the pull request that finished it |

The body has `## Goal`, `## Acceptance criteria` and `## Notes`. Reopening
adds dated lines under `## Review notes`. Notes left with `/unclaim <note>`,
`/note`, `0rch unclaim --note` or `0rch note` go under `## Earlier attempts`.
Both are part of every handoff.

### Function scopes

`src/game.c#Actor_Init` allows changing only the part of `src/game.c` that
holds `Actor_Init`:

- its `INCLUDE_ASM(..., Actor_Init)` or `#pragma GLOBAL_ASM(".../Actor_Init.s")`
  line,
- or the whole `#if(def|ndef) NON_MATCHING ... #else ... #endif` block around
  that stub,
- or its C definition, including return-type lines just above its name.

Every other byte of the file must be unchanged (line endings aside). A file
named both with and without `#` is fully in scope. In GitHub mode, tasks
naming different functions of the same file don't overlap; in local mode
they do (one shared checkout).

### Checks CI can't run

A task type with `ci: false` has a `verify` that needs files CI doesn't have
(for decomp, the original game). The tests job then runs `ci_verify` if set,
and otherwise passes with a note. Maintainers and players meeting the
`verify` fence run `0rch pr <number>` (scope first, then `verify` on the PR's
code) and comment `/verified`, which records a `verified` event.

### Ready

An open task is ready when every `depends_on` task is `done` and its scope
does not overlap any `claimed` or `review` task. Overlap is exact for files and
conservative for globs (two globs under the same folder overlap).

### Lifecycle

```
open ──claim──▶ claimed ──submit (passes)──▶ review ──accept──▶ done
  ▲               │  ▲                          │
  │      unclaim/expire  submit fails:          │
  └───────────────┘  stays claimed, costs trust │
  ▲                                             │
  └──────────────────reopen (note)──────────────┘
```

Flagging or banning a player reopens all of their `claimed` and `review` tasks
without further penalty.

## Verification

A submission passes only if all of these hold:

1. **Scope**: every changed file matches the task's `scope`, at least one does,
   and `0rchestrator.yml` is untouched. Changed files are taken from git
   (commits since `base` plus uncommitted work), from the fork's diff
   (`collect`), or from the returned packet (`unpack`).
2. **Checks**: the `verify` command exits 0 within the timeout. No command
   means a human or the conductor reviews it.

In a shared working tree, files another task has submitted are not held
against you while they match that task's `submitted_files`; touch one and it
counts. `accept` refuses if any submitted file changed after submission.

## Ledger

One JSON object per line:

```json
{"at":"2026-11-05T01:45:00.000Z","type":"accepted","player":"alice","task":"T-0001","size":"small","reward":0,"by":"owner"}
```

| Event | Points (default) |
| --- | --- |
| `claimed`, `released`, `submitted`, `banned`, `unbanned`, `verified` | 0 |
| `accepted` | +8 / +15 / +25 by size |
| `reopened` | −10 (0 when `penalty: false`) |
| `failed_submit` | −3 |
| `scope_violation` | −10 |
| `expired` | −5 |
| `flagged` | −50 |

A player's score is `starting_score` plus each event's points in order,
clamped to 0–100. Names are case-insensitive. Tiers: `banned`, `fenced` (below
the small fence), `new` (nothing accepted yet), `member`, `trusted` (meets the
sensitive fence).

## GitHub mode

With `workflow: github`, the default branch is the source of truth and the
workflow from `0rch init --github` keeps it up to date. Only the bot (running
as `github-actions[bot]`) writes `tasks/` and the ledger.

| Event | Job | What happens |
| --- | --- | --- |
| Push to the default branch touching `tasks/` or the config | bookkeeping | One issue per task, labeled `github.label` and titled `T-0003 · <title>`. Closes issues of done tasks and reopens reopened ones |
| Comment starting with `/` | bookkeeping | Runs the command below |
| PR opened, pushed to or retitled (`pull_request_target`) | scope | Checks the PR (rules below), comments one updatable report, fails if it doesn't pass |
| Same PR (`pull_request`) | tests | Runs `setup` and the task's check against the PR's code |
| PR merged | bookkeeping | Marks the task done, credits the PR author, closes the issue |
| Every 6 hours, or a manual run | bookkeeping | Releases expired claims (skipping tasks with an open PR) and re-syncs issues |

**Which task a PR is for:** the first task id (`T-0003`, `t3`, `T-3`) in its
title, else in its branch name. PRs without one are ignored.

**A PR passes the scope check when** the task exists and is claimed by the
PR's author, the author still passes the task's fences, every changed path
(including the old names of renamed files) is inside the task's scope, and
none is protected: `tasks/`, `.0rchestrator/`, `0rchestrator.yml` or
`.github/`.

**Trust model.** The scope job runs the workflow from the default branch with
a write token, but only reads the PR's file list through the API. It never
checks out or runs PR code. The tests job runs the PR's code with a read-only
token and no secrets, and loads the task, its scope and its check command from
the PR's base commit, so a PR can't loosen its own rules. A PR that edits the
workflow can change what its own tests job does. That's why `.github/` is
protected: the scope job, which a PR can't touch, fails it.

**Commands** (first line of an issue comment; bots are ignored):

| Command | Who | Effect |
| --- | --- | --- |
| `/claim` | Anyone | Claim this issue's task (subject to readiness and fences) |
| `/unclaim [note]` | The claimer, or a maintainer | Release it, no penalty; the note goes under Earlier attempts |
| `/note <text>` | The claimer, or a maintainer | Add to Earlier attempts |
| `/verified [note]` (on a PR) | Maintainer, or a player meeting the `verify` fence; never the PR's author | Record a `verified` event |
| `/trust [@user]` | Anyone | Reply with a trust record |
| `/help` | Anyone | List commands |
| `/release` | Maintainer | Release someone's claim, no penalty |
| `/reopen <note>` | Maintainer | Reopen with a note; the claimer loses trust |
| `/flag @user <reason>` | Maintainer | Flag: −50 and their open work is pulled back |
| `/ban @user <reason>`, `/unban @user` | Maintainer | Block or unblock claims |

Maintainers are commenters whose GitHub `author_association` is `OWNER`,
`MEMBER` or `COLLABORATOR`.

**Races.** Every bookkeeping change starts from a fresh fetch of the default
branch. If the push is rejected because someone else pushed first, the bot
starts over from their version (up to 5 tries). When two people `/claim` the
same task at once, the second sees the first's claim and is told no.

In GitHub mode, `scope_violation` is recorded once per PR (with its `pr`
number), and `accepted` events carry the `pr` that finished the task.
`failed_submit` is not used: failing tests just keep a PR from being merged.

## Packets

`0rch pack` writes:

```
HANDOFF.md      the prompt for the volunteer's AI, redacted
files/...       the task's context and scope files, redacted (binary files are left out)
packet.json     {"format":"0rchestrator-packet/1","task":"T-0001","project":"<alias>","scope":[...],"files":{"<path>":"<sha256 as sent>"}}
```

Redaction replaces each distinct match with `REDACTED_n`, in file contents and
paths alike. The mapping is saved to `.0rchestrator/redactions/<task>.json`.
`0rch unpack` treats a file as changed when its hash differs from the
manifest, restores placeholders, rejects any path outside the scope (or
escaping the project), applies the files, runs the checks, and rolls the
files back if the checks fail.

## Collecting forks

`0rch collect <task> <url> [--branch b]` fetches the fork, diffs it against the
merge base with the task's `base` (three-dot), ignores files whose content
already matches yours, and then follows the same steps as `unpack`. The fork's
GitHub owner is the player unless `--as` says otherwise.
