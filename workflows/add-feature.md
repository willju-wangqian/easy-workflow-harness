---
name: add-feature
description: Plan, implement, review, and test a new feature
trigger: "/ewh:doit add-feature"
---

## Steps

- name: plan
  agent: planner
  gate: structural
  rules: []
  context: []
  artifact: .ewh-artifacts/plan.md
  description: >
    Design the feature before implementation. The planner agent explores
    the codebase, weighs alternatives, and produces .ewh-artifacts/plan.md
    with files to create/modify, approach, key decisions, and acceptance
    criteria. If the brainstorming skill is available, the planner should
    use it for structured design.

- name: code
  agent: coder
  gate: structural
  rules: [coding]
  reads: [.ewh-artifacts/plan.md]
  context:
    - step: plan
      detail: full
  requires:
    - file_exists: .ewh-artifacts/plan.md
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
