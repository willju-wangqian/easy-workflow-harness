---
version: 1.0.1
---

# Easy Workflow Harness

A reusable workflow orchestration system for Claude Code. Standardizes how Claude behaves across projects through rules, workflows, agents, and a dispatcher.

## Paths

- Rules: ${CLAUDE_PLUGIN_ROOT}/rules/
- Workflows: ${CLAUDE_PLUGIN_ROOT}/workflows/
- Agents: ${CLAUDE_PLUGIN_ROOT}/agents/
- Dispatcher: ${CLAUDE_PLUGIN_ROOT}/skills/doit/SKILL.md
- Artifacts: .ewh-artifacts/ (ephemeral, per-workflow-run, cleaned up on completion)

## Project Integration

**Note:** The Claude Code runtime automatically injects the project's CLAUDE.md into every subagent. The dispatcher does NOT duplicate it — `## Project Context` contains only applicable Harness Config values.

Projects opt in at three levels:

1. **Zero config** — `/ewh:doit <name>` works anywhere. Dispatcher asks for missing values inline.
2. **Init'd** — `/ewh:doit init` adds `## Harness Config` to project CLAUDE.md with detected language, test command, source patterns.
3. **Customized** — project-level overrides:
   - `.claude/agents/` — override or extend plugin agents (via `extends: ewh:<name>`)
   - `.claude/rules/` — supplement plugin rules (concatenated, not replaced; recursive — files under subfolders like `.claude/rules/ewh/` are discovered automatically)
   - `.claude/workflows/` — replace plugin workflows entirely
   - `.ewh-artifacts/` — ephemeral step output (auto-created by dispatcher, should be gitignored)


## Override Resolution

| Artifact | Resolution | Merge behavior |
|---|---|---|
| Agent | Project `.claude/agents/` → Plugin `agents/` | Project replaces or extends |
| Rule | Plugin `rules/**/` + Project `.claude/rules/**/` | Recursive glob; all matches concatenated (plugin first, then project) |
| Workflow | Project `.claude/workflows/` → Plugin `workflows/` | Project replaces entirely |
| Harness Config | Project CLAUDE.md `## Harness Config` section | No plugin default |

## Usage

```bash
/ewh:doit init                                      # bootstrap project CLAUDE.md
/ewh:doit list                                      # list available workflows
/ewh:doit <name> [description]                      # run a workflow
/ewh:doit <name> --auto-approval [description]      # skip the startup "Proceed?" gate for THIS workflow
/ewh:doit <name> --need-approval [description]      # re-enable the startup "Proceed?" gate for THIS workflow
```

The `--auto-approval` / `--need-approval` flags toggle a **per-workflow** persisted switch stored in `.claude/ewh-state.json` under `auto_approve_start.<workflow_name>`. Each workflow has its own switch — setting it on `add-feature` does NOT affect `clean-up`. The plugin's workflow files declare a default of `false` in their frontmatter; `.claude/ewh-state.json` overrides on a per-project basis. The switch only affects the startup confirmation gate; structural per-step gates, compliance, error gates, and the stale-artifact cleanup gate are unaffected.

`.claude/ewh-state.json` is a per-project sidecar storing all dispatcher state: auto-approve switches (`auto_approve_start`) and chunked-dispatch file scopes (`chunked_scopes`). Recommended to gitignore for developer-local preferences, or commit to share team-wide scope settings.

## Design Spec

Design decisions are tracked in `specs/` within this repository.
