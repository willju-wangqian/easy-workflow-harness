# Easy Workflow Harness — Project Overview

## Purpose
A Claude Code plugin that orchestrates multi-step development workflows. Entirely Markdown — no build system, no runtime, no compiled code.

## Tech Stack
- Pure Markdown (.md files)
- Claude Code plugin system (skills, agents, rules, workflows)
- Node.js tooling only for docs build (remark/rehype in node_modules)

## Structure
```
skills/doit/SKILL.md   — the dispatcher (core orchestrator)
workflows/*.md         — workflow definitions
agents/*.md            — agent definitions (coder, reviewer, tester, scanner, compliance)
rules/*.md             — injectable rule files (coding, testing, review, knowledge)
HARNESS.md             — paths/settings config read by dispatcher at runtime
specs/                 — design decision specs
docs/                  — documentation
examples/              — example project overrides
.claude/specs/         — project-level specs
```

## Version
Currently 1.0.0 (see HARNESS.md frontmatter and CHANGELOG.md)

## Key Concepts
- Dispatcher reads workflow → resolves agents/rules → spawns agents with injected prompts
- Project overrides: `.claude/agents/`, `.claude/rules/`, `.claude/workflows/`
- Rules concatenate (plugin + project); agents and workflows: project replaces
- AGENT_COMPLETE sentinel: every agent must emit this as last line
- Gates: `structural` (always pauses), `auto` (silent), compliance failures always gate
