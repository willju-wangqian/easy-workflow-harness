---
name: create-workflow
description: Design and scaffold a project-specific workflow file in .claude/workflows/
trigger: "/ewh:doit create-workflow"
auto_approve_start: false
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
    Enter plan mode to design the workflow.
    Scan existing workflows in workflows/ and .claude/workflows/ for format patterns — show
    them to the user as concrete examples of frontmatter fields and step structure.
    If the brainstorming skill is available, use it for structured design.
    Gather user requirements: workflow name, description, trigger, and step definitions
    (name, agent, gate, rules, artifact, reads, requires, context for each step).
    Write the final plan with all gathered requirements to .ewh-artifacts/plan.md.

- name: propose
  agent: null
  gate: structural
  rules: []
  context:
    - step: plan
      detail: full
  reads: [.ewh-artifacts/plan.md]
  artifact: .ewh-artifacts/proposed-workflow.md
  requires:
    - file_exists: .ewh-artifacts/plan.md
  description: >
    Draft the complete workflow file with proper frontmatter (name, description,
    trigger) and a Steps section with all steps fully defined.
    Suggest improvements: artifact handoff between steps via reads/artifact,
    context flow declarations, gate type selection (structural vs auto),
    missing preconditions, rule assignments for each step.
    Present the full proposed content to the user for approval.
    Write the approved content to .ewh-artifacts/proposed-workflow.md.

- name: create
  agent: coder
  gate: structural
  rules: [coding]
  context:
    - step: propose
      detail: full
  reads: [.ewh-artifacts/proposed-workflow.md]
  requires:
    - file_exists: .ewh-artifacts/proposed-workflow.md
  description: >
    Write the approved workflow file to .claude/workflows/<name>.md exactly as proposed.
    Ensure the .claude/workflows/ directory exists (create it if needed).
    Do not alter the content — write it verbatim from the artifact.

- name: review
  agent: reviewer
  gate: auto
  rules: [review]
  context:
    - step: create
      detail: full
  requires:
    - prior_step: create
      has: files_modified
  description: >
    Review the created workflow file.
    Check: frontmatter complete (name, description, trigger), steps well-formed
    with all required fields, artifact/reads/context chain is coherent (no dangling
    references), agents referenced exist or are null, gate types appropriate,
    preconditions make sense.
