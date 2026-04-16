---
name: ewh-plugin-design
type: decision
status: accepted
scope: [distribution, plugin, harness]
created: 2026-04-09
---

# easy-workflow-harness Plugin Design

## Understanding Summary

- **What**: Package the Claude Code harness (dispatcher, rules, workflows, agents) as `easy-workflow-harness`, a community-distributable Claude Code plugin
- **Who**: Claude Code community at large — discoverable, self-documenting, beginner-friendly
- **Why**: Currently user-local at `~/.claude/harness/`. No way for others to install, update, or benefit
- **Constraint**: Plugin is markdown-only. All execution goes through Claude Code's standard agent/tool system
- **Invocation**: `/ewh:doit <name>` — short namespace, avoids collision with generic names
- **Brainstorming**: Not bundled. `add-feature` plan step defaults to plan mode, recommends brainstorming skill
- **v1 scope**: Dispatcher + 4 rules + 6 workflows + 4 agents + init + README. Version 0.9.0

## Decision

### Plugin Structure

```
easy-workflow-harness/
├── .claude-plugin/
│   └── plugin.json           # name: "ewh", version: "0.9.0"
├── skills/
│   └── doit/
│       └── SKILL.md          # dispatcher
├── agents/                   # auto-discovered by Claude Code
│   ├── coder.md
│   ├── reviewer.md
│   ├── tester.md
│   └── compliance.md
├── rules/                    # data files, read by dispatcher
│   ├── coding.md
│   ├── testing.md
│   ├── review.md
│   └── knowledge.md
├── workflows/                # data files, read by dispatcher
│   ├── add-feature.md
│   ├── refine-feature.md
│   ├── fact-check.md
│   ├── knowledge-update.md
│   ├── clean-up.md
│   └── init.md
├── HARNESS.md
├── README.md
└── LICENSE
```

### Path Resolution

Dispatcher uses `${CLAUDE_PLUGIN_ROOT}` (auto-substituted by Claude Code):
- Rules: `${CLAUDE_PLUGIN_ROOT}/rules/<name>.md`
- Workflows: `${CLAUDE_PLUGIN_ROOT}/workflows/<name>.md`
- Agents: `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`
- HARNESS.md: `${CLAUDE_PLUGIN_ROOT}/HARNESS.md`

### Override Resolution

| Artifact | Project path | Plugin path | Merge |
|---|---|---|---|
| Workflow | `.claude/workflows/<name>.md` | `${CLAUDE_PLUGIN_ROOT}/workflows/` | Project replaces |
| Rule | `.claude/rules/<name>.md` | `${CLAUDE_PLUGIN_ROOT}/rules/` | Concatenated |
| Agent | `.claude/agents/<name>.md` | `${CLAUDE_PLUGIN_ROOT}/agents/` | Project replaces/extends |
| Harness Config | CLAUDE.md `## Harness Config` | None | No plugin default |

Agent extension syntax: `extends: ewh:<name>`

### Naming

- Plugin name (plugin.json): `ewh`
- Package name (marketplace): `easy-workflow-harness`
- Skill folder: `doit`
- Invocation: `/ewh:doit <workflow-name>`

## Alternatives Considered

1. **Manual git clone install** — no auto-updates, no namespace isolation, higher friction
2. **Bundle brainstorming skill** — creates drift if brainstorming evolves independently
3. **Plugin-to-plugin dependency** — not supported by Claude Code plugin system
4. **`rules/` inside `skills/`** — overloads skills directory, breaks mental model
5. **Backwards-compat `harness:` prefix** — YAGNI with one existing user

## Acceptance Criteria

1. `claude --plugin-dir ./easy-workflow-harness` loads the plugin
2. `/ewh:doit list` shows all 6 workflows
3. `/ewh:doit init` bootstraps a fresh project's CLAUDE.md
4. `/ewh:doit add-feature` runs plan → code → review → test with gates
5. Project `.claude/rules/` supplements concatenate with plugin rules
6. Project `.claude/agents/` with `extends: ewh:coder` loads base + project
7. Project `.claude/workflows/` replaces plugin workflows
8. Plugin contains zero executable code (markdown only)

## Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Plugin distribution | Git clone, shell script | Official mechanism |
| 2 | Name: `ewh` / `easy-workflow-harness` | `claude-harness`, `claude-forge` | User preference |
| 3 | Invocation: `/ewh:doit` | `/ewh:w`, `/ewh:go`, `/ewh:run` | User preference |
| 4 | Audience: community | Power users, teams | Max impact |
| 5 | `${CLAUDE_PLUGIN_ROOT}` paths | Relative `../../` | Official env var |
| 6 | Data dirs alongside `skills/` | Relocate, flatten | Mirrors harness |
| 7 | Brainstorming: optional | Bundle, dependency, inline | Graceful degrade |
| 8 | `extends: ewh:`, no compat shim | Support both prefixes | YAGNI |
| 9 | Version `0.9.0` | `1.0.0` | Pre-release |
| 10 | Agents auto-discovered | Dispatcher-only | Free discovery |
