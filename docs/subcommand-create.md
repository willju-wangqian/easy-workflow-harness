# Subcommand: create

**Invoke:** `/ewh:doit create [rule|agent|workflow]`

Scaffold a project-specific rule, agent, or workflow file interactively. The dispatcher gathers requirements, drafts the file, validates it against a template, and writes it to the appropriate `.claude/` directory.

## What It Does

1. Determines the type — from argument or by asking the user
2. Reads the validation template (`templates/<type>.md`) for required fields and checklist
3. Scans existing files of that type to show 1-2 examples as reference
4. Gathers requirements interactively (one question at a time)
5. Drafts the complete file and shows a full preview
6. Validates against the template checklist — reports issues
7. On confirmation, writes to `.claude/<type>s/<name>.md`

## Flags

| Flag | Effect |
|---|---|
| `--no-override` | Force the built-in `create` subcommand when a project workflow `.claude/workflows/create.md` exists |

## Type-Specific Requirements

### Rules

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `scope` | Tags (e.g., `[code, security]`) |
| `severity` | `default` or `critical` |
| `inject_into` | Target agent names |
| `verify` | Shell command for compliance checking |

Output: `.claude/rules/<name>.md`

### Agents

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `model` | `sonnet`, `haiku`, or `opus` |
| `tools` | Tool list (respecting read-only/read-write tier) |
| `maxTurns` | Maximum turn count |

Body must include `## Before You Start` self-gating section and `AGENT_COMPLETE` sentinel instruction.

Output: `.claude/agents/<name>.md`

### Workflows

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `trigger` | `/ewh:doit <name>` |
| `steps` | Sequence of step definitions |

Each step needs: `name`, `agent`, `gate`, `rules`, `description`. Optional: `artifact`, `reads`, `requires`, `context`, `chunked`, `script`, `script_fallback`.

Output: `.claude/workflows/<name>.md`

## Validation

The dispatcher validates the draft against the template's checklist before writing. Issues are reported inline and the user can fix them before confirming the write.

Validation templates are located at `${CLAUDE_PLUGIN_ROOT}/templates/` — one per type (`rule.md`, `agent.md`, `workflow.md`). If a template is missing, the dispatcher falls back to its own knowledge of the format.

## Example

```bash
/ewh:doit create rule
```

```
Scanning existing rules for reference...

Here's what an existing rule looks like:
  rules/coding.md — name, description, scope, severity, inject_into, verify

Let's create your rule. One question at a time:

Name (kebab-case):
> no-raw-sql

Description:
> Forbid raw SQL queries — all database access must use parameterized statements

Scope tags:
> [code, security]

Severity (default / critical):
> critical

...

Proposed rule file: .claude/rules/no-raw-sql.md

---
name: no-raw-sql
description: Forbid raw SQL queries — all database access must use parameterized statements
scope: [code, security]
severity: critical
inject_into: [coder, reviewer]
verify: "grep -rn 'execute(' src/ | grep -v 'parameterized' | head -5"
---

[body content]

Validation: all checks passed.
Write this file? (confirm / edit / abort)
> confirm

Created .claude/rules/no-raw-sql.md. This will take effect on next workflow run.
```

## Notes

- `create` is a **subcommand**, not a workflow. It does not spawn agents — the dispatcher writes the file directly after user confirmation.
- This replaces the previous `create-rules`, `create-agents`, and `create-workflow` workflows.
- If a project workflow `.claude/workflows/create.md` (or `create-rules.md`, etc.) exists, the old workflow names no longer match built-in workflows. The `create` subcommand only triggers on the name `create`.
