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
  context: []
  artifact: .claude/artifacts/plan.md
  description: >
    Enter plan mode to design the feature before implementation.
    If the brainstorming skill is available, it is highly recommended
    for structured design (understanding lock, decision log, alternatives).
    Otherwise, use Claude's built-in plan mode to explore approaches,
    validate understanding, and produce a design before coding.
    Write the final plan to .claude/artifacts/plan.md — include:
    files to create/modify, approach, key decisions, and acceptance criteria.

- name: code
  agent: coder
  gate: structural
  rules: [coding]
  reads: [.claude/artifacts/plan.md]
  context:
    - step: plan
      detail: full
  requires:
    - file_exists: .claude/artifacts/plan.md
  description: >
    Implement the design from the plan step.
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
    Write tests for the new feature.
    Cover happy path, error cases, and edge cases.
    Run full test suite and report results.
