---
name: create-rules
description: Design and scaffold a project-specific rule file in .claude/rules/
trigger: "/ewh:doit create-rules"
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
    Enter plan mode to design the rule.
    Scan existing rules in rules/ and .claude/rules/ for format patterns — show
    them to the user as concrete examples of frontmatter fields and section style.
    If the brainstorming skill is available, use it for structured design.
    Gather user requirements: rule name, description, scope, severity,
    inject_into targets, and verify command (shell command for automated checking).
    Write the final plan with all gathered requirements to .claude/artifacts/plan.md.

- name: propose
  agent: null
  gate: structural
  rules: []
  context:
    - step: plan
      detail: full
  reads: [.claude/artifacts/plan.md]
  artifact: .claude/artifacts/proposed-rule.md
  requires:
    - file_exists: .claude/artifacts/plan.md
  description: >
    Draft the complete rule file with proper frontmatter (name, description,
    scope, severity, inject_into, verify) and rule body sections.
    Suggest improvements: verify commands for automated checking, severity tuning
    (default vs critical), scope coverage, additional actionable sections.
    Present the full proposed content to the user for approval.
    Write the approved content to .claude/artifacts/proposed-rule.md.

- name: create
  agent: coder
  gate: structural
  rules: [coding]
  context:
    - step: propose
      detail: full
  reads: [.claude/artifacts/proposed-rule.md]
  requires:
    - file_exists: .claude/artifacts/proposed-rule.md
  description: >
    Write the approved rule file to .claude/rules/<name>.md exactly as proposed.
    Ensure the .claude/rules/ directory exists (create it if needed).
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
    Review the created rule file.
    Check: frontmatter has all required fields (name, description, scope,
    severity, inject_into, verify), sections are clear and actionable,
    rule is specific enough to be enforceable, verify command is valid shell syntax.
