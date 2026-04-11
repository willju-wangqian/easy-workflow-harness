---
name: refine-feature
description: Scan, suggest, implement, review, and test improvements to existing code
trigger: "/ewh:doit refine-feature"
---

## Steps

- name: scan
  agent: scanner
  gate: auto
  rules: [review]
  context: []
  artifact: .claude/artifacts/scan-findings.md
  description: >
    Scan the target code area for improvement opportunities.
    Report findings organized by severity.
    Focus on the area described by the user.
    Write findings to .claude/artifacts/scan-findings.md.

- name: propose
  agent: null
  gate: structural
  rules: []
  context:
    - step: scan
      detail: full
  reads: [.claude/artifacts/scan-findings.md]
  artifact: .claude/artifacts/approved-improvements.md
  requires:
    - file_exists: .claude/artifacts/scan-findings.md
  description: >
    Present scan findings to user for approval.
    User selects which improvements to implement.
    Write the approved list to .claude/artifacts/approved-improvements.md.
    This is a decision gate — no changes until confirmed.

- name: code
  agent: coder
  gate: structural
  rules: [coding]
  context:
    - step: propose
      detail: full
  reads: [.claude/artifacts/approved-improvements.md]
  requires:
    - file_exists: .claude/artifacts/approved-improvements.md
  description: >
    Implement the approved improvements.
    Follow coding rules and project conventions.
    Run tests after changes.

- name: review
  agent: reviewer
  gate: auto
  rules: [review]
  context:
    - step: code
      detail: full
  requires:
    - prior_step: code
      has: files_modified
  description: >
    Review all changes from the code step.
    Check for bugs, quality issues, and rule compliance.
    Report findings with severity ratings.

- name: test
  agent: tester
  gate: auto
  rules: [testing]
  context:
    - step: code
      detail: full
    - step: review
      detail: summary
  requires:
    - prior_step: code
      has: files_modified
  description: >
    Write or update tests for the refined code.
    Cover any new behavior introduced by improvements.
    Run full test suite and report results.
