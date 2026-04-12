---
name: create-agents
description: Design and scaffold a project-specific agent file in .claude/agents/
trigger: "/ewh:doit create-agents"
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
    Enter plan mode to design the agent.
    Scan existing agents in agents/ and .claude/agents/ for format patterns — show
    them to the user as concrete examples of frontmatter fields and required sections.
    If the brainstorming skill is available, use it for structured design.
    Gather user requirements: agent name, description, model, tools, maxTurns,
    role description, and behavior constraints.
    Write the final plan with all gathered requirements to .ewh-artifacts/plan.md.

- name: propose
  agent: null
  gate: structural
  rules: []
  context:
    - step: plan
      detail: full
  reads: [.ewh-artifacts/plan.md]
  artifact: .ewh-artifacts/proposed-agent.md
  requires:
    - file_exists: .ewh-artifacts/plan.md
  description: >
    Draft the complete agent file with proper frontmatter (name, description,
    model, tools, maxTurns) and all required sections: Role, Inputs, Before You
    Start (self-gating checklist), Behavior, Output Format, and AGENT_COMPLETE
    sentinel instruction as the final output instruction.
    Suggest improvements: tool selection, maxTurns tuning, self-gating conditions,
    output format fields.
    Present the full proposed content to the user for approval.
    Write the approved content to .ewh-artifacts/proposed-agent.md.

- name: create
  agent: coder
  gate: structural
  rules: [coding]
  context:
    - step: propose
      detail: full
  reads: [.ewh-artifacts/proposed-agent.md]
  requires:
    - file_exists: .ewh-artifacts/proposed-agent.md
  description: >
    Write the approved agent file to .claude/agents/<name>.md exactly as proposed.
    Ensure the .claude/agents/ directory exists (create it if needed).
    The file must include the AGENT_COMPLETE sentinel instruction as its final output instruction.
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
    Review the created agent file.
    Check: frontmatter complete (name, description, model, tools, maxTurns),
    Before You Start section present with self-gating checklist,
    Output Format section defined, AGENT_COMPLETE sentinel instruction present
    as the last output instruction, role and behavior are clear and actionable.
