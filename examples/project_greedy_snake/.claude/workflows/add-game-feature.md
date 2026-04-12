---
name: add-game-feature
description: Plan, implement, verify in-browser, review, and test a new game feature
trigger: "/ewh:doit add-game-feature"
---

## Steps

- name: plan
  agent: null
  skill: null
  gate: structural
  rules: []
  context: []
  artifact: .ewh-artifacts/plan.md
  description: >
    Enter plan mode to design the game feature before implementation.
    If the brainstorming skill is available, use it for structured design.
    Otherwise, use plan mode to explore approaches and validate understanding.
    Write the final plan to .ewh-artifacts/plan.md — include:
    files to create/modify, approach, key decisions, and acceptance criteria.

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
    Implement the game feature from the plan step.
    Follow coding rules and project conventions.
    Run tests after changes.

- name: verify
  agent: null
  gate: structural
  rules: []
  context:
    - step: code
      detail: full
  requires:
    - prior_step: code
      has: files_modified
  description: >
    Present the user with verification instructions:
    1. Open index.html in a browser
    2. List specific behaviors to check based on the feature implemented
    3. Ask user to confirm the feature works visually as expected
    This is a manual verification gate — no agent runs.

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
    Write tests for the new game feature.
    Cover happy path, error cases, and edge cases.
    Run full test suite and report results.

- name: celebrate
  agent: ergo
  gate: auto
  rules: []
  context:
    - step: code
      detail: summary
    - step: review
      detail: summary
    - step: test
      detail: summary
  description: >
    Deliver a dry-wit one-liner based on workflow outcome.
