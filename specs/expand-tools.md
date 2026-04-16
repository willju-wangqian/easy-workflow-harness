---
name: expand-tools
type: decision
status: accepted
scope: [dispatcher, agents, tool-management]
created: 2026-04-16
version: 1.0.2
---

# Expand Tools — Persistent Agent Tool Expansion via Subcommand

## Understanding Summary

- **What**: `/ewh:doit expand-tools` subcommand that discovers available tools, understands user intent, proposes per-agent tool assignments, persists config in `ewh-state.json`, and auto-generates `.claude/agents/<name>.md` overrides
- **Why**: Plugin reinstalls overwrite in-place tool patches in `agents/*.md`; a persistent config that regenerates overrides on demand solves this
- **Who**: EWH users who extend agents with MCP/plugin/CLI tools
- **Non-goals**: No auto-reconciliation at dispatcher startup; no direct editing of plugin agent files

## Design

### Invocation

```
/ewh:doit expand-tools [description]
```

Recognized as a special command (same level as `list`). Does not enter the step execution loop. `[description]` is the user's intent (e.g., "add Serena read/write tools for semantic code navigation"). If omitted, the dispatcher asks.

### Flow — First Run

**Phase 1 — Intent Gathering**: Use the user's description (or ask). Clarify which agents to expand if ambiguous.

**Phase 2 — Tool Discovery**: Search the user's environment for available tools (MCP servers, plugins, CLI). Match against user intent using LLM judgment. Classify each tool as read-only or read-write.

**Phase 3 — Proposal**: Present a per-agent assignment table showing agent, tier, and proposed tools. Warn inline if write tools are proposed for read-only agents ("⚠ breaks separation-of-concerns guarantee"). User can: approve all / edit (add/remove per agent) / reject. Loop until resolved.

**Phase 4 — Persist to `ewh-state.json`**: Write under `agent_tools` key:

```json
{
  "agent_tools": {
    "coder": {
      "add": ["mcp__serena__find_symbol", "mcp__serena__replace_symbol_body"],
      "source": "Serena MCP",
      "configured_at": "2026-04-16"
    },
    "reviewer": {
      "add": ["mcp__serena__find_symbol", "mcp__serena__get_symbols_overview"],
      "source": "Serena MCP",
      "configured_at": "2026-04-16"
    }
  }
}
```

Merge with existing entries (additive, duplicates skipped). Each source tracked separately.

**Phase 5 — Generate Override Files**: For each agent in `agent_tools`:
1. Read plugin agent (`${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`) for default `tools:` list
2. If `.claude/agents/<name>.md` exists → ask: "Existing override found. Merge tools into it, or skip?"
   - Merge: update only `tools:` frontmatter (union), preserve all other content
   - Skip: leave as-is, warn tools won't take effect
3. If no existing override → generate:
   ```markdown
   ---
   extends: ewh:<name>
   tools: [<default tools>, <expanded tools>]
   ---
   ```
4. Create `.claude/agents/` directory if needed

**Phase 6 — Summary**: Report per-agent changes, file paths, and "Run `/ewh:doit expand-tools` again to update or add more."

### Flow — Rerun (Update & Reconcile)

When `agent_tools` already exists in `ewh-state.json`:

1. Show current state (per-agent table of existing expansions)
2. Ask intent:
   - **Add more tools** → enter Phase 1-6; new tools merge with existing
   - **Remove tools** → present per-agent list, user selects removals. Update `ewh-state.json`, regenerate overrides.
   - **Regenerate overrides** → rebuild all `.claude/agents/<name>.md` from current `ewh-state.json`. Use after plugin reinstall.
   - **Clear all** → remove `agent_tools` from `ewh-state.json`, delete generated override files (with confirmation)

### Read-Only Tier Enforcement

Agents have two tiers:
- **Read-only**: scanner, reviewer, compliance — should only receive read-only tools
- **Read-write**: coder, tester — may receive both

When a write tool is proposed for a read-only agent: warn with explanation, allow if user confirms. Not a hard block.

### Edge Cases

- **No MCP servers connected**: inform user, offer manual tool name entry
- **Plugin agent file not readable**: warn, skip that agent
- **Existing override has different `extends:` target**: don't merge, warn and skip
- **MCP server disconnected after expansion**: tools in config reference unavailable server. Claude Code ignores unavailable tools silently. `expand-tools` notes the issue when rerun.
- **Multiple tool sources**: accumulate by source. Each source removable independently.
- **`ewh-state.json` missing**: create it (existing dispatcher behavior)

## Alternatives Considered

| Approach | Why rejected |
|---|---|
| Store in `ewh-state.json` + inject via prompt | Doesn't actually grant tool access; Claude Code scopes tools from frontmatter |
| Reconcile at dispatcher startup | Adds cost for all users; `expand-tools` is explicit and zero-cost when unused |
| Workflow instead of subcommand | Overkill — no agents/gates/compliance needed for a config wizard |
| Hard block write tools on read-only agents | Users may have valid reasons; warn is sufficient |
| Manual-only tool entry | Misses the opportunity for LLM-driven discovery matching user intent |

## Decision Log

| # | Decision | Why |
|---|----------|-----|
| 1 | Subcommand, not workflow | Simpler; no agents/gates needed for a config wizard |
| 2 | `ewh-state.json` as source of truth | Survives plugin reinstalls; overrides are generated artifacts |
| 3 | Reconcile only via `expand-tools` | Keeps startup fast; zero cost for non-users |
| 4 | LLM-driven discovery based on user intent | More flexible than manual entry |
| 5 | Warn (not block) write tools on read-only agents | Users may have valid reasons |
| 6 | Ask to merge or skip existing overrides | Respects hand-written overrides |
| 7 | Per-source tracking | Clean add/remove per tool source |
| 8 | Single command for full lifecycle | Add, remove, regenerate, clear — one entry point |

## Acceptance Criteria

1. `/ewh:doit expand-tools` discovers tools and proposes per-agent assignments based on user intent
2. Approved expansions persisted in `ewh-state.json` under `agent_tools`
3. Override files generated at `.claude/agents/<name>.md` with merged tool lists
4. Rerunning `expand-tools` shows current state and offers add/remove/regenerate/clear
5. Write tools on read-only agents produce a warning, not a hard block
6. Existing hand-written overrides prompt merge-or-skip, never silently overwritten
7. After plugin reinstall, `expand-tools` → "Regenerate overrides" restores tool expansions
8. Existing workflows and dispatcher startup unaffected (no performance cost)
