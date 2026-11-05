# Changelog

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
