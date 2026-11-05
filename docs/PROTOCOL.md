# The 0rchestrator protocol (v0.1)

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

Volunteers never edit `tasks/` or `.0rchestrator/` by hand. In fork and packet
mode, changes there are ignored; in a shared tree they are bookkeeping written
by the CLI.

## 0rchestrator.yml

```yaml
name: textkit
visibility: public            # or private
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
| `scope` | The only paths this task may create, change or delete. Files, folders (`src/`) or globs (`src/**/*.js`) |
| `context` | Read-only files shown to the volunteer's AI |
| `verify` | Optional command that overrides the type's |
| `claimed_by`, `claimed_at`, `base` | Set on claim (`base` = the commit the work starts from) |
| `submitted_at`, `submitted_files` | Set on submit (`submitted_files` = a sha256 of each submitted file) |
| `completed_at` | Set on accept |

The body has `## Goal`, `## Acceptance criteria` and `## Notes`. Reopening
adds dated lines under `## Review notes`.

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
| `claimed`, `released`, `submitted`, `banned`, `unbanned` | 0 |
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
