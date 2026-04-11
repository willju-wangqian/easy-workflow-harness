---
name: fact-check
description: Cross-validate documentation against source code
trigger: "/ewh:doit fact-check"
---

## Steps

- name: scan-docs
  agent: reviewer
  gate: auto
  rules: [knowledge]
  description: >
    Scan all maintained documentation files (CLAUDE.md, specs, memory files,
    README) for factual claims about the codebase: function names, file paths,
    line numbers, dependency lists, return value descriptions.
    Produce a checklist of claims to verify.

- name: validate
  agent: reviewer
  gate: auto
  rules: [knowledge]
  description: >
    For each claim from the scan step, verify against current source code.
    Use Read, Grep, and Glob to check:
    - Function names exist and match signatures described
    - File paths exist on disk
    - Line number references are approximately correct
    - Dependency lists match the project manifest
    - Architecture descriptions match actual code structure
    Report: confirmed claims, stale/wrong claims with evidence.

- name: propose-fixes
  agent: null
  gate: structural
  rules: [knowledge]
  description: >
    Present all stale/wrong claims to the user with evidence.
    Propose specific corrections for each.
    User must approve before any changes are made.

- name: apply-fixes
  agent: coder
  gate: auto
  rules: [knowledge, coding]
  description: >
    Apply the approved documentation corrections.
    Only change what was explicitly approved in the propose step.
    Cite the source code that proves each correction.
