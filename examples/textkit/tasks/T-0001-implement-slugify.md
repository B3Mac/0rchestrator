---
id: T-0001
title: Implement slugify()
type: code
size: small
status: open
depends_on: []
scope:
  - src/slugify.js
context:
  - src/index.js
  - test/slugify.test.js
verify: node --test test/slugify.test.js
---

## Goal

Replace the stub in src/slugify.js with a real slugify(text) that turns any string into a URL-safe slug.

## Acceptance criteria

- All tests in test/slugify.test.js pass
- No dependencies added; plain modern JavaScript

## Notes

_None yet._
