---
name: knowledge
description: Standards for maintaining project documentation and harness state
scope: [update-knowledge, check-fact]
severity: default
inject_into: [coder, scanner]
verify: null
---

## Source of Truth

- Source code is the final authority — docs follow code, never the reverse
- NAMESPACE, DESCRIPTION, and equivalents are generated artifacts — read but don't hand-edit
- Git history is authoritative for who-changed-what and when

## CLAUDE.md

- Keep it concise — architecture overview, key commands, conventions, Harness Config
- No procedural workflows (those live in harness workflow files)
- Update when: exports change, dependencies change, conventions change, architecture changes
- Do not add information derivable from reading the code

## Memory Files

- Update current-status and next-steps when project state changes materially
- Convert relative dates to absolute dates
- Remove stale entries — if a risk was resolved, delete it
- Don't duplicate what's in CLAUDE.md or specs

## Documentation Files (README, pkgdown, etc.)

- Function names and signatures must match current exports
- File paths must exist on disk
- Dependency lists must match the project manifest
- Code examples must run without error
- When fixing docs, cite the source code that proves the correction

## What NOT to Document

- Debugging sessions or fix recipes (the fix is in the code)
- Conversation-specific context
- Anything that will be stale in a week
