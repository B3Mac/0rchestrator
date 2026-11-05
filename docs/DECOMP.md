# 0rchestrator for decompilation projects

Matching decomp is thousands of small, independent puzzles, and each one has a
perfect test: does it compile to the original bytes? That's exactly what
0rchestrator is built for. Today, people end up working on the same functions
and losing their partial progress. 0rchestrator gives every function to
exactly one person at a time and keeps their notes for whoever comes next.

**What it adds to your existing project:**

- **One task per function**, generated from your `INCLUDE_ASM` /
  `#pragma GLOBAL_ASM` stubs, smallest first.
- **Function-level scopes.** A task may change one function and nothing else
  in its file, so many people can work in the same file at once and their PRs
  merge cleanly.
- **Notes carry forward.** Someone stuck at 93% gives the task back with a
  note and a decomp.me link, and the next person (or their AI) starts from
  there.
- **Local models welcome.** `0rch run` lets anyone grind on a function with a
  model on their own GPU: retries are free and the match check is the judge.
  See [LOCAL-MODELS.md](LOCAL-MODELS.md).
- **No ROMs, ever.** Volunteers use their own copy of the game. Nothing
  copyrighted is shared, and CI never needs it.

Try the whole flow in 10 seconds: `npm run demo` (act 3 is a decomp sprint on
[examples/decomp-mini](../examples/decomp-mini)).

## Set up (project owners)

```bash
npm install -g github:B3Mac/0rchestrator
cd your-decomp-repo
0rch init --github --decomp
```

Then set the match check in `0rchestrator.yml`. It runs on volunteers' and
maintainers' machines, where the game files are:

```yaml
task_types:
  decomp:
    verify: "make && sha1sum -c baserom.sha1"   # the ROM still matches
    ci: false                                   # CI never has the game
    ci_verify: null                             # optional: something CI can run
```

`{symbol}`, `{file}` and `{task}` are filled in per task (also available as
`$ORCH_SYMBOL`, `$ORCH_FILE` and `$ORCH_TASK`). Common choices:

| Project style | Check |
| --- | --- |
| splat / N64, PS1, PS2 (`INCLUDE_ASM`, `asm/nonmatchings/`) | `make && sha1sum -c <rom>.sha1`, or `make compare` |
| IDO / `#pragma GLOBAL_ASM` | your build plus its checksum step |
| GameCube / Wii (decomp-toolkit, objdiff) | `ninja` then an `objdiff-cli` check on `{symbol}` |
| Anything | a script of your own: `./tools/check_match.sh {symbol}` |

A whole-ROM checksum works for per-function tasks because unfinished
functions stay as asm: if the ROM still matches after replacing one stub, that
function matches.

Make tasks, easiest first, in batches:

```bash
0rch decomp scan                      # what's still in asm, sized by instruction count
0rch decomp scan --create --limit 25  # make the 25 easiest
0rch doctor
git add -A && git commit -m "0rchestrator: first 25 functions" && git push
```

Run `0rch decomp scan` after your project's setup has extracted the asm, so
tasks get real sizes. Each task's context points at its `.s` file. That file
stays git-ignored, and every volunteer generates their own from their own
game.

Track progress with `0rch decomp progress`.

## How a function gets done

1. A volunteer comments `/claim` on the function's issue.
2. They write C for that one function: by hand, with m2c, on decomp.me, or with
   their AI. `0rch prompt T-0042` gives their AI the stub, the surrounding
   code, the asm, and any earlier attempts.
3. `0rch verify T-0042` runs your match check, and confirms nothing else in
   the file changed.
4. They open a PR titled `T-0042: ...`. On it:
   - **scope** (trusted) checks that only that function changed, reading both
     versions of the file through the API.
   - **tests** (sandboxed) runs `ci_verify` if you set one. It can't run the
     real match: CI has no game.
5. Someone with the game checks it for real:

   ```bash
   0rch pr 123          # scope first, then your match check on the PR's code
   ```

   Then they comment `/verified` on the PR. Maintainers, and players with
   trust 70+ and 3 accepted tasks, can verify. Nobody can verify their own PR.
6. A maintainer merges, and the volunteer gets the credit.

**Close but not 100%?** Hand it back with what you learned:

```
/unclaim 93%: regalloc swaps a1/a2 in the loop. https://decomp.me/scratch/AbC12
```

or keep it and add a note with `/note ...`. Notes appear under **Earlier
attempts** in every future handoff.

## Rules of the road

- **Never commit or share game files**: no ROMs, ISOs, extracted assets,
  or asm. 0rchestrator never asks for them, and tasks only point at paths
  each volunteer generates locally.
- **One function per task** keeps PRs small and conflict-free. Shared headers
  (new structs, externs) need their own task, or a maintainer adds them; a
  function task can't touch them.
- `NON_MATCHING` blocks count as the function: a task may replace the whole
  `#ifdef NON_MATCHING ... #else INCLUDE_ASM ... #endif` block.

## Running locally instead of on GitHub

`0rch init --decomp` (without `--github`) works the same way in one checkout.
There, tasks in the same file run one at a time. Volunteers can also send work
from their own clones with `0rch collect <task> <fork-url>`, which merges
function by function.
