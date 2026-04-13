# Expanding ewh Agent Tool Lists

Use this prompt to extend ewh agents with tools from an external MCP tool set
(e.g. Serena, GitHub MCP, browser automation). Fill in the placeholders, then
paste the result into a Claude Code conversation.

---

## Prompt

```
## Context

I use the Easy Workflow Harness (ewh) plugin for Claude Code.
ewh defines workflow agents (scanner, reviewer, compliance, coder, tester)
as markdown files with YAML frontmatter in the `agents/` directory of the
ewh plugin installation.
Each agent has an explicit `tools` list in its frontmatter that enforces
its access level — read-only agents like scanner and reviewer must never
gain write access, while coder and tester may create and modify files.
Agent definitions are located at: [AGENT_DIR]

## Agent Roles and Access Tiers

Agents fall into two tiers based on their role:

**Read-only agents** (must never modify files or state):
- [LIST_READONLY_AGENTS]
- Permitted operations: reading, searching, analyzing, reporting

**Read-write agents** (may create or modify files):
- [LIST_READWRITE_AGENTS]
- Permitted operations: reading, searching, AND creating/modifying files

## Task

Expand the `tools` list in each agent's frontmatter to include tools from the
following external tool set: [TOOL_SET_NAME]

The available tools in this set, split by access tier, are:

**Read-only tools** (safe for all agents):
[LIST_READONLY_TOOLS]

**Read-write tools** (only for read-write agents):
[LIST_READWRITE_TOOLS]

## Rules

1. Read-only agents: add only read-only tools from [TOOL_SET_NAME]
2. Read-write agents: add both read-only and read-write tools from [TOOL_SET_NAME]
3. Preserve all existing tools — do not remove any
4. Do not change any other frontmatter fields (name, description, model, maxTurns)
5. Do not change the agent's prompt body
6. If a tool is already in the list, do not duplicate it

## Output

For each agent file, produce the updated frontmatter `tools` line only.
Show: filename → updated tools line.
Then ask for confirmation before writing any files.
```

---

## Placeholder Reference

| Placeholder | Description | Example |
|---|---|---|
| `[AGENT_DIR]` | Absolute path to the `agents/` directory | `/Users/alice/.claude/plugins/cache/ewh/agents/` |
| `[LIST_READONLY_AGENTS]` | ewh agents that must stay read-only | `scanner.md, reviewer.md, compliance.md` |
| `[LIST_READWRITE_AGENTS]` | ewh agents allowed to write | `coder.md, tester.md` |
| `[TOOL_SET_NAME]` | Name of the external tool set | `Serena (mcp__serena__*)` |
| `[LIST_READONLY_TOOLS]` | Tool names safe for read-only agents | see example below |
| `[LIST_READWRITE_TOOLS]` | Tool names that modify state | see example below |

---

## Example: Serena MCP

```
[AGENT_DIR]             → /Users/willju/development/easy-workflow-harness/agents/
[LIST_READONLY_AGENTS]  → scanner.md, reviewer.md, compliance.md
[LIST_READWRITE_AGENTS] → coder.md, tester.md
[TOOL_SET_NAME]         → Serena (mcp__serena__*)

[LIST_READONLY_TOOLS]
  mcp__serena__find_symbol
  mcp__serena__get_symbols_overview
  mcp__serena__find_referencing_symbols
  mcp__serena__list_memories
  mcp__serena__read_memory

[LIST_READWRITE_TOOLS]
  mcp__serena__replace_symbol_body
  mcp__serena__insert_after_symbol
  mcp__serena__insert_before_symbol
  mcp__serena__rename_symbol
  mcp__serena__safe_delete_symbol
  mcp__serena__write_memory
  mcp__serena__edit_memory
  mcp__serena__delete_memory
```
