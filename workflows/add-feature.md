---
name: add-feature
description: Plan, implement, review, and test a new feature
trigger: "/ewh:doit add-feature"
---

## Steps

- name: plan
  agent: null
  skill: null
  gate: structural
  rules: []
  description: >
    Enter plan mode to design the feature before implementation.
    If the brainstorming skill is available, it is highly recommended
    for structured design (understanding lock, decision log, alternatives).
    Otherwise, use Claude's built-in plan mode to explore approaches,
    validate understanding, and produce a design before coding.

- name: code
  agent: coder
  gate: structural
  rules: [coding]
  description: >
    Implement the design from the plan step.
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
    Write tests for the new feature.
    Cover happy path, error cases, and edge cases.
    Run full test suite and report results.

- name: compliance
  agent: compliance
  gate: auto
  rules: [coding, testing]
  only_if: has_critical_rules
  description: >
    Verify critical rules were followed.
    Only runs if any active rule has severity: critical.
