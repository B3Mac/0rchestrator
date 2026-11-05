# Goal

Decompile **decomp-mini**, a tiny pretend N64 game, into C that matches the
original machine code exactly. It's the example project for using 0rchestrator
on a decompilation.

Each function still written as `INCLUDE_ASM(...)` in `src/` is one task.
Write C for that one function until the match check says 100%, and change
nothing else in the file.

## Done looks like

- No `INCLUDE_ASM` left in `src/`
- `node tools/match.js <function>` reports a 100% match for every function

## Out of scope

- Renaming or restyling functions that are already decompiled
- Anything that needs the original game's assets
