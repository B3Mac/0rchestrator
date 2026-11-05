# Changelog

## 0.3.0

**Decomp projects, and your own compute.**

- **Function-level scopes:** `src/game.c#Actor_Init` lets a task change only
  that function (its `INCLUDE_ASM` / `GLOBAL_ASM` stub, `NON_MATCHING` block,
  or C definition). Enforced in `verify`, both PR checks, `collect` and
  packets. In GitHub mode, different functions of one file can be worked at
  the same time.
- `0rch decomp scan [--create --limit N --per-file]`: one task per function
  still in asm, sized by instruction count, smallest first.
  `0rch decomp progress`.
- `0rch init --decomp`: a `decomp` task type whose check runs locally
  (`ci: false`), with an optional `ci_verify` for CI.
- Check commands can use `{symbol}`, `{file}` and `{task}` (also
  `$ORCH_SYMBOL`, `$ORCH_FILE`, `$ORCH_TASK`).
- `0rch pr <n>`: check a PR on your own machine (scope first, then the full
  check), then comment `/verified`. `/verified` needs a maintainer or the new
  `verify` trust fence (70+, 3 accepted), and never your own PR.
- **Notes carry forward:** `/unclaim <note>`, `/note <text>`,
  `0rch unclaim --note`, and `0rch note` add to "Earlier attempts", which is
  in every future handoff.
- **`0rch run`:** let a local model (Ollama, LM Studio, llama.cpp, vLLM, or
  any OpenAI-compatible API) do a task. It only applies edits inside the
  scope, splices function answers into place, runs the check, feeds failures
  back, and puts files back if it never passes. `--loop` works through tasks
  in local mode. Also `0rch models`.
- `collect` and `unpack` now do a real three-way merge, so work on different
  parts of a file no longer overwrites changes merged in the meantime.
  Overlapping changes are reported as conflicts, with no trust penalty.
- `doctor` checks that function scopes exist and that decomp tasks have a
  match check.
- New guides: [DECOMP.md](docs/DECOMP.md), [LOCAL-MODELS.md](docs/LOCAL-MODELS.md).
  New example: [examples/decomp-mini](examples/decomp-mini). The demo gains
  act 3.

## 0.2.0

**GitHub mode: put 0rchestrator in a real project today.**

- `0rch init --github` adds the workflow, sets `workflow: github`, guesses
  your `setup` and check commands, and prints a README badge.
- Tasks become issues labeled `0rchestrator`, kept in sync on every push.
- Volunteers comment `/claim`; the bot assigns them and replies with the
  handoff. Also `/unclaim`, `/trust`, `/help`; maintainers get `/release`,
  `/reopen`, `/flag`, `/ban`, `/unban`.
- Every task PR gets two checks: **scope** (trusted, reads the file list from
  the API, never runs PR code) and **tests** (sandboxed, using the base
  commit's task rules so a PR can't rewrite its own checks).
- Merging a PR credits its author, closes the issue, and announces which
  tasks it unlocked. Out-of-scope PRs cost trust once per PR.
- Expired claims are released every 6 hours, unless a PR is open for them.
- Concurrent claims are safe: the bot retries on push races, so two people
  can't both win the same task.
- `0rch doctor` checks a project is ready for volunteers.
- `0rch verify --base <ref>`; in GitHub mode, `play`/`claim` point to
  `/claim` and `submit` tells you to open a PR.
- New guides: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) and
  [docs/VOLUNTEER.md](docs/VOLUNTEER.md).

## 0.1.0

First version: the `0rch` CLI, task protocol, trust ledger and fences,
flag/ban, private projects with redacted packets, fork collection, an MCP
server, the textkit example and a narrated demo.
