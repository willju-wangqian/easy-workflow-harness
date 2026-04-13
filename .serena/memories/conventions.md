# Conventions

## File Format
All agent, rule, and workflow files require YAML frontmatter. Required fields:

- **Agent**: `name`, `description`, `model`, `tools`, `maxTurns`
- **Rule**: `name`, `description`, `scope`, `severity`, `inject_into`, `verify`
- **Workflow**: `name`, `description`, `trigger`, optional `auto_approve_start`

## Agent Structure
Every agent definition must include:
1. `## Before You Start` — self-gating section (bail with AGENT_COMPLETE if context missing)
2. Output format instructions
3. Final instruction: emit `AGENT_COMPLETE` as the very last line of output

## Prompt Assembly Order
agent template → `## Required Reading` → `## Active Rules` → `## Prior Steps` → `## Task` → `## Project Context`
Maintain this order when editing the dispatcher.

## Rule Severity
- `severity: critical` + `verify:` shell command → triggers automatic compliance check after step
- `severity: warning` → advisory only

## Naming
- Workflow files: kebab-case (`add-feature.md`)
- Agent files: kebab-case (`coder.md`, `compliance.md`)
- Rule files: kebab-case, organized by topic

## Specs
Design decisions tracked in `specs/SPECS.md` (and `.claude/specs/` for project-level). Use brainstorming skill to create new specs; use `/specs` to manage lifecycle.
