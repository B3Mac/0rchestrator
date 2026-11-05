# Tasks

Each task is one Markdown file here. The conductor writes them; volunteers
only ever change a task's status through the `0rch` commands.

```markdown
---
id: T-0001
title: Add slugify()
type: code            # a type from 0rchestrator.yml
size: small           # small | medium | large
status: open          # open | claimed | review | done | blocked
sensitive: false      # true = only highly trusted players can claim it
reward: 10            # optional, credited when accepted
depends_on: []        # task ids that must be done first
scope:                # the ONLY paths this task may change
  - src/slugify.js
context:              # read-only files the volunteer's AI should see
  - test/slugify.test.js
verify: node --test test/slugify.test.js   # optional, overrides the type
---

## Goal
## Acceptance criteria
## Notes
```
