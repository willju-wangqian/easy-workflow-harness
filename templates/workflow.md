---
type: workflow
required_frontmatter:
  - name
  - description
  - trigger
---

## Frontmatter Reference

| Field | Required | Description | Valid values |
|---|---|---|---|
| `name` | yes | Workflow identifier (matches filename without .md) | kebab-case string |
| `description` | yes | One-line summary of what this workflow does | free text |
| `trigger` | yes | The command to invoke this workflow | `/ewh:doit <name>` |
| `auto_approve_start` | no | Default for the startup "Proceed?" gate | `true` or `false` (default: `false`) |

## Body Structure

The workflow body must contain a `## Steps` section with a YAML list. Each step is a list item with the following fields:

### Required Step Fields

| Field | Description | Valid values |
|---|---|---|
| `name` | Step identifier (unique within workflow) | kebab-case string |
| `agent` | Which agent runs this step | agent name, or `null` for dispatcher-driven steps |
| `gate` | When the workflow pauses | `structural` (always pause) or `auto` (proceed silently) |
| `rules` | Rules injected into the agent prompt | array of rule names (e.g., `[coding, review]`) |
| `description` | What this step does | multi-line YAML string |

### Optional Step Fields

| Field | Description | Valid values |
|---|---|---|
| `skill` | Invoke a skill instead of an agent | skill name (e.g., `brainstorming`) |
| `context` | Prior steps to include in prompt | array of `{step: <name>, detail: raw\|full\|summary}` |
| `artifact` | File path for step's primary output | path under `.ewh-artifacts/` |
| `reads` | Files the agent must read before starting | array of file paths |
| `requires` | Preconditions evaluated before the step runs | array of conditions (see below) |
| `chunked` | Enable parallel fan-out for large file sets | `true` or `false` |
| `script` | Path to a pre-defined Bash script | file path |
| `script_fallback` | Behavior when a script fails | `gate` (default) or `auto` |

### Requires Conditions

Two forms:
- `prior_step: <name>` + `has: <field>` — prior step's summary must contain a non-empty value for that field
- `file_exists: <path>` — file must exist on disk

## Validation Checklist

- [ ] All required frontmatter fields present and non-empty
- [ ] `name` matches the filename (without .md extension)
- [ ] `trigger` follows the `/ewh:doit <name>` pattern
- [ ] Body contains a `## Steps` section
- [ ] Each step has all required fields (`name`, `agent`, `gate`, `rules`, `description`)
- [ ] Step names are unique within the workflow
- [ ] `gate` values are either `structural` or `auto`
- [ ] `agent` values reference agents that exist in `agents/` or `.claude/agents/` (or are `null`)
- [ ] `rules` values reference rules that exist in `rules/` or `.claude/rules/`
- [ ] `context` entries reference steps defined earlier in the workflow
- [ ] `artifact` paths are under `.ewh-artifacts/`
- [ ] `reads` paths reference existing files or artifacts from prior steps
- [ ] `requires` conditions reference valid prior steps or file paths
- [ ] `chunked: true` and `script:` are not both set on the same step
- [ ] No overlap with existing workflows (check `workflows/` and `.claude/workflows/`)
