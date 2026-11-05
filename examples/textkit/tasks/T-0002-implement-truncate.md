---
id: T-0002
title: Implement truncate()
type: code
size: small
status: open
depends_on: []
scope:
  - src/truncate.js
context:
  - src/index.js
  - test/truncate.test.js
verify: node --test test/truncate.test.js
---

## Goal

Replace the stub in src/truncate.js with truncate(text, max, ending = '…') that shortens text to at most max characters, ending included.

## Acceptance criteria

- All tests in test/truncate.test.js pass
- Cuts at a word boundary when one is available

## Notes

_None yet._
