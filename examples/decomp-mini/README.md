# decomp-mini

A tiny pretend N64 game, set up the way real matching-decomp projects are
(splat style: `INCLUDE_ASM` stubs in `src/`, extracted asm in
`asm/nonmatchings/`), for trying 0rchestrator's decomp features.

```bash
cp -r examples/decomp-mini /tmp/decomp-mini && cd /tmp/decomp-mini
git init -q && git add -A && git commit -qm init
0rch decomp progress          # 1 of 5 functions in C
0rch decomp scan --create     # one task per asm function
0rch claim T-0001 --as you
0rch prompt T-0001            # give this to your AI, or:
0rch run T-0001 --model qwen2.5-coder:14b --attempts 10   # a local model via Ollama
0rch verify T-0001
```

**What's pretend:**

- **The asm** is hand-written MIPS-style code, not from any real game. In a real
  project, `asm/` is generated from each volunteer's own copy of the game and
  is never committed.
- **`tools/match.js` stands in for the real match check.** A real check builds
  with the game's original compiler and compares bytes (`make compare`,
  objdiff). This one compares your C to a fingerprint of the original,
  ignoring formatting and local variable names, the way a compiler would. It
  prints a match percentage and the first difference, like the real tools do.

The demo's act 3 (`npm run demo` in the repo root) runs a whole sprint on this
project.
