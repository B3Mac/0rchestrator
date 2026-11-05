# Use your own compute

No Claude or ChatGPT plan? A GPU and a local model can still do real work.
`0rch run` is a small agent loop for models that don't come with one:

1. It sends your model the task: the goal, the rules, and the files.
2. It applies the model's edits, but only inside the task's scope. Edits to
   anything else, like the tests, are thrown away.
3. It runs the task's check. If that fails, the model gets the output and
   tries again.

It works with anything that speaks the OpenAI-style API: **Ollama**,
**LM Studio**, **llama.cpp's server**, **vLLM**, LocalAI, and cloud endpoints too.

## Quick start (Ollama)

```bash
ollama pull qwen2.5-coder:14b     # or any coding model your machine can run
0rch models                       # what your server has
0rch run T-0042 --model qwen2.5-coder:14b
```

Other servers:

```bash
0rch run T-0042 --endpoint http://localhost:1234/v1 --model <name>   # LM Studio
0rch run T-0042 --endpoint http://localhost:8080/v1 --model <name>   # llama.cpp server
```

Set defaults once so you can just type `0rch run T-0042`:

```bash
export ORCH_LLM_ENDPOINT=http://localhost:11434/v1
export ORCH_LLM_MODEL=qwen2.5-coder:14b
export ORCH_LLM_API_KEY=...        # only for servers that need one
```

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `--attempts N` | 3 | Tries before giving up. Local compute is free, so raise it: decomp often needs 10–20 |
| `--context-chars N` | 24000 | How much of the files to send. Lower it for small context windows |
| `--temperature T` | 0.2 | Higher gives more varied tries |
| `--timeout S` | 600 | Seconds to wait for one answer |
| `--submit` | off | Local mode: hand the work in when it passes |
| `--keep` | off | Leave the last failed attempt on disk instead of putting files back |
| `--loop` | off | Local mode: keep taking tasks you're cleared for until none are left |

Every attempt is saved to a temp folder (the path is printed), so you can see
what the model tried.

## On a GitHub project

1. Comment `/claim` on the task's issue, then pull so your copy knows.
2. `0rch run T-0042 --attempts 15`.
3. When it passes, look over the diff, commit, and open the PR it tells you
   about. If it doesn't pass, comment `/unclaim <what it tried>` so the next
   person knows.

## Leave it running

In local mode, `--loop` works through every task you're allowed to take. It
hands back the ones it can't do, with a note so the next volunteer doesn't
repeat the same tries:

```bash
0rch run --loop --as your-name --attempts 10
```

## What to expect

- **Small, well-tested tasks suit local models best.** The fences already
  start everyone on small tasks.
- **Decomp is a great fit.** The match check is an exact, automatic judge, and
  `0rch run` shows the model the match tool's diff each time. For function
  tasks the model writes only that function, and 0rch splices it in, so it
  can't damage the rest of the file.
- Models that think out loud are fine: `<think>` blocks are ignored.
- Your model only sees the task's slice of the project, on your machine.

## Prefer your own tools?

`0rch prompt T-0042` prints the full handoff for any chat app. Apps that
support MCP can use 0rchestrator's tools directly with `0rch mcp`.
