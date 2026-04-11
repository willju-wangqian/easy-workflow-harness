---
version: 0.9.0
---

# Easy Workflow Harness

A reusable workflow orchestration system for Claude Code. Standardizes how Claude behaves across projects through rules, workflows, agents, and a dispatcher.

## Paths

- Rules: ${CLAUDE_PLUGIN_ROOT}/rules/
- Workflows: ${CLAUDE_PLUGIN_ROOT}/workflows/
- Agents: ${CLAUDE_PLUGIN_ROOT}/agents/
- Dispatcher: ${CLAUDE_PLUGIN_ROOT}/skills/doit/SKILL.md

## Settings

- default_gate: auto
- compliance_enabled: true
- compliance_model: haiku

## Project Integration

Projects opt in at three levels:

1. **Zero config** — `/ewh:doit <name>` works anywhere. Dispatcher asks for missing values inline.
2. **Init'd** — `/ewh:doit init` adds `## Harness Config` to project CLAUDE.md with detected language, test command, source patterns.
3. **Customized** — project-level overrides:
   - `.claude/agents/` — override or extend plugin agents (via `extends: ewh:<name>`)
   - `.claude/rules/` — supplement plugin rules (concatenated, not replaced)
   - `.claude/workflows/` — replace plugin workflows entirely

## Override Resolution

| Artifact | Resolution | Merge behavior |
|---|---|---|
| Agent | Project `.claude/agents/` → Plugin `agents/` | Project replaces or extends |
| Rule | Plugin `rules/` + Project `.claude/rules/` | Concatenated (both apply) |
| Workflow | Project `.claude/workflows/` → Plugin `workflows/` | Project replaces entirely |
| Harness Config | Project CLAUDE.md `## Harness Config` section | No plugin default |

## Usage

```
/ewh:doit <name> [description]    # run a workflow
/ewh:doit list                    # list available workflows
/ewh:doit init                    # bootstrap project CLAUDE.md
```

## Design Spec

Full design rationale: see `ewh-plugin-design.md` in the originating project's `.claude/specs/`.
