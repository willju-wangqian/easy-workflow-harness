# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Easy Workflow Harness (EWH) is a Claude Code plugin that orchestrates multi-step development workflows. The plugin consists of a Node/TypeScript binary (`bin/ewh`, compiled via esbuild) plus Markdown workflow/agent/rule definitions. The binary holds all orchestration logic; the Markdown files define workflows, agents, and rules that the binary reads at runtime. `skills/doit/SKILL.md` is a thin shim that invokes the binary each turn.

## Commands

```bash
# Build
npm run build         # compile src/ → bin/ewh.mjs (esbuild)
npm run typecheck     # tsc --noEmit

# Test
npm test              # run vitest
npm run test:coverage # vitest with coverage

# Run locally
claude --plugin-dir /path/to/easy-workflow-harness
```

Then in any project:

```bash
# Subcommands (lightweight, interactive)
/ewh:doit init                         # bootstrap project + onboarding guide
/ewh:doit cleanup                     # run configured cleanup tasks
/ewh:doit cleanup --manage-tasks      # configure cleanup tasks
/ewh:doit create rule                  # scaffold a rule (also: agent, workflow)
/ewh:doit expand-tools "description"   # discover and persist agent tool expansions

# Workflows (multi-step, agent-driven)
/ewh:doit list                         # list available workflows and subcommands
/ewh:doit add-feature "description"    # run a workflow
/ewh:doit add-feature --trust          # auto-approve structural gates this run
/ewh:doit add-feature --manage-scripts # manage cached scripts before running
```

## Architecture

**Binary drives; LLM executes.** `bin/ewh` is the dispatcher. `skills/doit/SKILL.md` is a thin shim (~60 lines) that invokes `ewh start "$ARGUMENTS"` once, then loops: read the `ACTION:` block, execute the named tool call, run `ewh report` to hand back the result. All orchestration state lives in the binary; the LLM only runs tool calls and reports.

**Name resolution** (when user runs `/ewh:doit <name>`): project workflow override (`.claude/workflows/`) → built-in subcommand → plugin workflow (`workflows/`). `--no-override` forces a subcommand when a same-name project workflow exists.

**Subcommands** (`init`, `cleanup`, `create`, `expand-tools`, `list`) are implemented in `src/commands/*.ts`. No agents, rules, compliance, or artifact workspace — each subcommand is a multi-turn state machine (stored in `RunState.subcommand_state`) that emits one action per turn.

**Workflows** (`add-feature`, `refine-feature`, `update-knowledge`, `check-fact`) use the full step state machine in `src/state/machine.ts`. Each step advances through typed phases:

- Normal path: `pending → gate_pending → agent_run → artifact_verify → compliance → complete`
- Script path: `pending → script_eval → script_propose → script_run → artifact_verify → compliance → complete`
- Chunked path: `pending → chunk_plan → chunk_running → chunk_merge → compliance → complete`
- Recovery path: `agent_run → continuation → split → split_merge`

**State persistence**: every transition writes `RunState` atomically to `.ewh-artifacts/<run-id>/state.json` (tmp → fsync → rename) before emitting the next instruction. Crash-resume is free — next `ewh report` re-reads state and re-emits the same instruction.

**File-indirection**: full agent prompts written to `.ewh-artifacts/<run-id>/step-N-prompt.md`; outer session carries only the path (~30 tokens vs. ~5k in v1). Result files likewise written by agents; binary reads them on `ewh report`.

**Drift detection**: `hooks/hooks.json` (plugin-bundled, no install step) appends tool-call records to `.ewh-artifacts/<run-id>/turn-log.jsonl`. On each `ewh report`, binary compares last-instructed tool against log since last offset. Level 2 (default): warn and continue. Level 3 (`--strict`): gate.

**Resolution order** (project always wins for agents and workflows; rules concatenate):

| Artifact | Resolution |
|---|---|
| Agent | `.claude/agents/<name>.md` → `agents/<name>.md` |
| Rule | `rules/**/<name>.md` + `.claude/rules/**/<name>.md` (recursive glob, all matches concatenated) |
| Workflow | `.claude/workflows/<name>.md` → `workflows/<name>.md` |

## Key Contracts

**AGENT_COMPLETE sentinel**: Every agent definition must instruct the agent to emit exactly `AGENT_COMPLETE` as the last line. The dispatcher uses this to detect partial output.

**Harness Config**: The `init` subcommand appends a `## Harness Config` section to the project's CLAUDE.md. The binary reads this for test commands, source patterns, etc. Agents receive it under `## Project Context`.

**Prompt assembly order**: agent template → `## Required Reading` → `## Active Rules` → `## Prior Steps` (from `context:` field) → `## Task` → `## Project Context`. Maintain this order when editing `src/workflow/prompt-builder.ts`.

**CLAUDE.md**: The Claude Code runtime automatically injects the project's CLAUDE.md into every subagent. The dispatcher's `## Project Context` section contains only Harness Config values — it does not duplicate CLAUDE.md.

**Gate types**: Four independent classes — `startup` (before first step; skippable via `--auto-approval` or `--trust`), `structural` (per-step `gate: structural`; skippable via `--trust` or `--yolo`), `compliance` (after `severity: critical` rule fails; never auto-persisted, only `--yolo` skips it for a single run), `error` (agent crash / missing artifact / script non-zero; gates after `max_error_retries` exhausted; configurable via `--max-retries N` or persisted via `--save`). `--yolo --save` is rejected.

## Extending the Harness

**New workflow**: add `workflows/<name>.md` with frontmatter (`name`, `description`, `trigger`) and a `## Steps` list. Each step needs: `name`, `agent`, `gate`, `rules`, `description`. Optional step fields:

- `artifact: <path>` — the step writes its primary output to this file (under `.ewh-artifacts/`). The dispatcher appends a write instruction to the agent's `## Task` section. Downstream steps use `reads:` to consume it.
- `reads: [<path>, ...]` — files the agent must read before starting. The dispatcher injects a `## Required Reading` section into the prompt listing these paths. Use for artifact handoff between steps.
- `requires:` — preconditions evaluated before the step runs. If any fail, the step is skipped with a log entry. Two forms:
  - `prior_step: <name>` + `has: <field>` — the named prior step's summary must contain a non-empty value for that field (e.g., `files_modified`)
  - `file_exists: <path>` — the file must exist on disk (typically an artifact from a prior step)
- `context: [{step: <name>, detail: raw|full|summary}, ...]` — declares which prior steps the agent receives under ## Prior Steps and at what compression level. `full` (~5-10 bullets with decisions and file detail), `summary` (1-3 bullets + file list), `raw` (uncompressed agent output). Steps not listed are excluded. If omitted or empty, the agent gets no ## Prior Steps section.
- `chunked: true` — enables proactive chunked dispatch for steps that fan out across many files. On first run, the binary prompts the user for include/exclude glob patterns and stores them in `.claude/ewh-state.json` under `chunked_patterns["<workflow>/<step>"]`. On subsequent runs, cached patterns are reused. The binary enumerates matching files, splits into chunks (default 8 per chunk), spawns parallel workers, and merges results into the step's artifact via a merge agent. If file count ≤ `max_per_chunk`, runs as a normal single agent. State machine phases: `chunk_plan → chunk_running → chunk_merge`.
- `script: <path>` — path to a pre-defined Bash script. If set, the binary runs this script instead of spawning an agent. If omitted, the binary checks for a cached script at `.claude/ewh-scripts/<workflow>/<step>.sh`, then evaluates whether the step is scriptable. Mutually exclusive with `chunked: true`. State machine phases: `script_eval → script_propose → script_run`.
- `script_fallback: gate | auto` — controls behavior when a script fails (non-zero exit). `gate` (default): stop and offer retry/edit/agent-fallback/skip/abort. `auto`: silently fall back to the step's agent (requires `agent:` to be defined).

**New rule**: add `rules/<name>.md` with frontmatter (`name`, `description`, `scope`, `severity`, `inject_into`, `verify`). `inject_into` is advisory metadata (not enforced — workflow `rules:` lists control injection). Set `severity: critical` and provide a `verify` shell command to trigger automatic compliance checks.

**New agent**: add `agents/<name>.md` with frontmatter (`name`, `description`, `model`, `tools`, `maxTurns`). Must include a `## Before You Start` self-gating section (verify context sufficiency, bail with `AGENT_COMPLETE` if missing) and output format instructions ending with the `AGENT_COMPLETE` sentinel instruction. Optional frontmatter field `incremental: true` marks the agent as a list-producer (findings, review issues, test entries) for chunked dispatch: the binary pre-creates each chunk artifact with an append anchor and instructs the worker to `Edit`-append per finding, so partial progress survives turn-cap truncation. The `Edit` tool must be included in `tools:` when `incremental: true` is set. For incremental agents, `continuation` and `split` phases are skipped on per-chunk failure — the binary gates directly to the user; retry re-spawns the same prompt and the agent resumes from disk.

**Project overrides**: `.claude/agents/<name>.md` replaces the plugin agent (or extends via `extends: ewh:<name>`). `.claude/rules/<name>.md` supplements (concatenated; recursive — `.claude/rules/ewh/<name>.md` and other subfolders are discovered automatically). `.claude/workflows/<name>.md` replaces entirely.

**Cached scripts**: `.claude/ewh-scripts/<workflow>/<step>.sh` stores approved scripts for scriptable steps. Generated by the dispatcher (§1d) when a step is identified as scriptable and the user approves the proposed script. Managed via `--manage-scripts` flag. Gitignore for developer-local preferences, or commit to share team-wide scripts.

## Harness Config

<!-- Generated by /ewh:doit init — edit values as needed -->

- Language: none (Markdown plugin)
- Test command: none
- Check command: none
- Source pattern: **/*.md
- Test pattern: none
- Doc build: none
- Conventions: frontmatter on all agent/rule/workflow files; AGENT_COMPLETE sentinel in all agent definitions
