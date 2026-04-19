# Easy Workflow Harness — Project Overview

## Purpose
A Claude Code plugin that orchestrates multi-step development workflows. The dispatcher is a compiled Node/TypeScript binary; Markdown files define workflows, agents, and rules that the binary reads at runtime.

## Tech Stack
- Node.js + TypeScript (compiled via esbuild to a single ESM bundle)
- vitest for unit + integration tests
- Zod for runtime schema validation; `yaml`, `glob` as deps
- Markdown (.md) for workflow/agent/rule/template definitions

## Structure
```
bin/ewh                — bash shim that execs bin/ewh.mjs (Node)
bin/ewh.mjs            — compiled dispatcher bundle (produced by npm run build)
src/                   — TypeScript source (state machine, commands, workflow engine)
  commands/            — init, cleanup, create, expand-tools, list
  state/machine.ts     — typed state machine (17 phases)
  workflow/            — parser, prompt-builder, etc.
  continuation/        — continuation / split / split_merge phases
  scripts/             — script_eval / script_propose / script_run phases
  chunking/            — chunked dispatch
tests/                 — vitest suite (unit + integration)
skills/doit/SKILL.md   — thin LLM-facing shim (~70 lines); invokes `ewh start`/`report`
skills/doit/list.md    — static catalog printed by the `list` subcommand
workflows/*.md         — workflow definitions (add-feature, refine-feature, check-fact, update-knowledge, hello, trivial)
agents/*.md            — agent definitions (coder, reviewer, tester, scanner, compliance, hello)
rules/*.md             — injectable rule files (coding, testing, review, knowledge)
templates/             — scaffolding templates used by `ewh create`
hooks/hooks.json       — plugin-bundled drift-detection hooks
HARNESS.md             — paths/settings read by the binary at startup
.claude-plugin/        — plugin.json and marketplace.json manifests
specs/                 — design decision specs (SPECS.md is the index)
docs/                  — user docs (one file per workflow/subcommand)
examples/              — example project overrides
```

## Version
v2.0.0 — see `package.json` and `.claude-plugin/plugin.json`.

## Key Concepts (v2)
- **Binary drives; LLM executes.** Each turn the LLM calls `ewh start` or `ewh report`, reads the emitted `ACTION:` block, runs one tool call, and reports back. State lives in the binary.
- **File-indirection for prompts.** Full agent prompts written to `.ewh-artifacts/<run-id>/step-N-prompt.md`; outer session carries only the path.
- **Atomic state persistence.** Every transition writes `state.json` (tmp → fsync → rename). Crash-resume is free.
- **Project overrides:** `.claude/agents/`, `.claude/rules/`, `.claude/workflows/`. Rules concatenate (plugin + project, recursive); agents and workflows: project replaces.
- **AGENT_COMPLETE sentinel:** every agent must emit this as last line.
- **Four gate classes:** `startup`, `structural`, `compliance`, `error`.
- **Flags:** `--trust`, `--yolo`, `--max-retries`, `--save`, `--strict`, `--auto-approval`, `--need-approval`, `--manage-scripts`, `--manage-tasks`, `--no-override`.
