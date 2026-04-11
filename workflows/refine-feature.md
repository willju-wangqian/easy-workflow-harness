---
name: refine-feature
description: Scan, suggest, implement, review, and test improvements to existing code
trigger: "/ewh:doit refine-feature"
---

## Steps

- name: scan
  agent: reviewer
  gate: auto
  rules: [coding, review]
  description: >
    Scan the target code area for improvement opportunities.
    Report findings organized by severity.
    Focus on the area described by the user.

- name: propose
  agent: null
  gate: structural
  rules: []
  description: >
    Present scan findings to user for approval.
    User selects which improvements to implement.
    This is a decision gate — no changes until confirmed.

- name: code
  agent: coder
  gate: structural
  rules: [coding]
  description: >
    Implement the approved improvements.
    Follow coding rules and project conventions.
    Run tests after changes.

- name: review
  agent: reviewer
  gate: auto
  rules: [coding, review]
  description: >
    Review all changes from the code step.
    Check for bugs, quality issues, and rule compliance.
    Report findings with severity ratings.

- name: test
  agent: tester
  gate: auto
  rules: [testing]
  description: >
    Write or update tests for the refined code.
    Cover any new behavior introduced by improvements.
    Run full test suite and report results.

- name: compliance
  agent: compliance
  gate: auto
  rules: [coding, testing]
  only_if: has_critical_rules
  description: >
    Verify critical rules were followed.
    Only runs if any active rule has severity: critical.
