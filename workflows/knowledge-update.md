---
name: knowledge-update
description: Update CLAUDE.md, memory files, and project documentation to match current state
trigger: "/ewh:doit knowledge-update"
---

## Steps

- name: read-governance
  agent: null
  gate: auto
  rules: [knowledge]
  description: >
    Dispatcher reads the project's maintenance rules or governance docs
    directly (no agent needed). Identifies which files are maintained,
    what triggers updates, and what the update scope is.
    If no governance docs exist, use the knowledge rule defaults.

- name: inspect-state
  agent: reviewer
  gate: auto
  rules: [knowledge]
  artifact: .claude/artifacts/inspection-results.md
  description: >
    Inspect current project state against maintained documentation:
    - Compare CLAUDE.md architecture/commands/conventions against source
    - Check memory files (current-status, next-steps) against git log and test results
    - Check spec files for stale references
    - Run git log to identify recent changes not reflected in docs
    Write results to .claude/artifacts/inspection-results.md:
    what needs updating, with specific diffs proposed.

- name: apply-updates
  agent: coder
  gate: structural
  rules: [knowledge, coding]
  reads: [.claude/artifacts/inspection-results.md]
  requires:
    - file_exists: .claude/artifacts/inspection-results.md
  description: >
    Apply the proposed documentation updates.
    Present changes to user before writing.
    Only update what the inspect step identified as stale.
    Follow the knowledge rule: source code is the authority.
