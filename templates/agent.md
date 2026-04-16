---
type: agent
required_frontmatter:
  - name
  - description
  - model
  - tools
  - maxTurns
---

## Frontmatter Reference

| Field | Required | Description | Valid values |
|---|---|---|---|
| `name` | yes | Agent identifier (matches filename without .md) | kebab-case string |
| `description` | yes | One-line summary of the agent's role | free text |
| `model` | yes | Which Claude model to use | `sonnet`, `haiku`, `opus` |
| `tools` | yes | List of tools available to this agent | array of tool names (e.g., `[Read, Glob, Grep, Bash]`) |
| `maxTurns` | yes | Maximum number of turns the agent can take | positive integer |

## Tool Tier Guidance

- **Read-only agents** (scanning, reviewing, compliance): tools should be limited to `Read`, `Glob`, `Grep`, `Bash` (for read-only commands), and read-only MCP tools
- **Read-write agents** (coding, testing): may additionally include `Write`, `Edit`, and write MCP tools

## Body Structure

The agent body must include these sections:

1. **Role description** — what this agent does, its responsibilities, and behavioral boundaries
2. **## Before You Start** — self-gating checklist. The agent must verify it has sufficient context before proceeding. If context is missing, the agent reports what's missing and emits `AGENT_COMPLETE` without doing work.
3. **Output format** — how the agent structures its response (findings, changes, reports)
4. **AGENT_COMPLETE sentinel** — instructions to emit exactly `AGENT_COMPLETE` on its own line as the last line of output

## Validation Checklist

- [ ] All required frontmatter fields present and non-empty
- [ ] `name` matches the filename (without .md extension)
- [ ] `model` is one of: `sonnet`, `haiku`, `opus`
- [ ] `tools` list contains only valid tool names
- [ ] `tools` list respects the agent's access tier (read-only agents have no write tools)
- [ ] `maxTurns` is a positive integer
- [ ] Body contains a `## Before You Start` section with context-checking logic
- [ ] Body contains output format instructions
- [ ] Body instructs the agent to emit `AGENT_COMPLETE` as the last line
- [ ] No overlap with existing agents (check `agents/` and `.claude/agents/`)
