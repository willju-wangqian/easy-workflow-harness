---
name: clean-up
description: Run tests, check package, build docs, then update knowledge
trigger: "/ewh:doit clean-up"
---

## Steps

- name: test
  agent: null
  gate: auto
  rules: [testing]
  context: []
  description: >
    Dispatcher runs test command from Harness Config directly.
    No agent needed — single command execution.
    If tests fail, gate and report failures before proceeding.

- name: check
  agent: null
  gate: auto
  rules: []
  context:
    - step: test
      detail: summary
  description: >
    Dispatcher runs check command from Harness Config.
    (e.g., devtools::check(), npm run lint, cargo clippy)
    Report failures before proceeding.

- name: build-docs
  agent: null
  gate: auto
  rules: []
  context:
    - step: test
      detail: summary
    - step: check
      detail: summary
  description: >
    Dispatcher runs doc build command from Harness Config.
    If project has a README source (README.Rmd, README.qmd, etc.),
    render it too. Report any build errors.

- name: knowledge-update
  agent: null
  gate: auto
  rules: [knowledge]
  context:
    - step: test
      detail: summary
    - step: check
      detail: summary
    - step: build-docs
      detail: summary
  description: >
    Trigger the knowledge-update workflow as a sub-workflow.
    Sub-workflow: /ewh:doit knowledge-update
    Prior steps context carries forward from parent.
