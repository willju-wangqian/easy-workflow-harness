# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Easy Workflow Harness (EWH) is a Claude Code plugin that orchestrates multi-step development workflows. It is entirely Markdown — no build system, no runtime, no tests to run. Changes to `.md` files are the primary form of development here.

## Commands

To test locally, launch Claude Code with this plugin loaded:

```bash
claude --plugin-dir /path/to/easy-workflow-harness
```

Then in any project:

```bash
/ewh:doit list                         # list available workflows
/ewh:doit init                         # bootstrap project CLAUDE.md
/ewh:doit add-feature "description"   # run a workflow
/ewh:doit add-feature --manage-scripts # manage cached scripts before running
```

## Architecture

The dispatcher (`skills/doit/SKILL.md`) is the core. When a user runs `/ewh:doit <name>`, it:

1. Reads `HARNESS.md` for paths/settings
2. Resolves the workflow from `workflows/<name>.md` (project `.claude/workflows/` takes precedence)
3. Prepares `.ewh-artifacts/` workspace (warns if stale artifacts exist and waits for user confirmation before clearing)
4. For each step: evaluates preconditions (`requires:`), checks gate, resolves scripts (§1d — runs cached/proposed scripts for mechanical steps, saving tokens), validates early (already-done/trivial), resolves rules, builds prompt (with `reads:` and `artifact:` directives), validates context, spawns agent, checks `AGENT_COMPLETE` sentinel, verifies artifact written
5. If sentinel is absent (partial output): spawns one continuation agent to finish remaining work; if that also fails, splits into 30-item parallel chunks and merges results
6. After steps with `severity: critical` rules: spawns the compliance agent to verify
7. On completion: cleans up `.ewh-artifacts/`

**Resolution order** (project always wins for agents and workflows; rules concatenate):

| Artifact | Resolution |
|---|---|
| Agent | `.claude/agents/<name>.md` → `agents/<name>.md` |
| Rule | `rules/**/<name>.md` + `.claude/rules/**/<name>.md` (recursive glob, all matches concatenated) |
| Workflow | `.claude/workflows/<name>.md` → `workflows/<name>.md` |

## Key Contracts

**AGENT_COMPLETE sentinel**: Every agent definition must instruct the agent to emit exactly `AGENT_COMPLETE` as the last line. The dispatcher uses this to detect partial output.

**Harness Config**: The `init` workflow appends a `## Harness Config` section to the project's CLAUDE.md. The dispatcher reads this for test commands, source patterns, etc. Agents receive it under `## Project Context`.

**Prompt assembly order**: agent template → `## Required Reading` → `## Active Rules` → `## Prior Steps` (from `context:` field) → `## Task` → `## Project Context`. Maintain this order when editing the dispatcher.

**CLAUDE.md**: The Claude Code runtime automatically injects the project's CLAUDE.md into every subagent. The dispatcher's `## Project Context` section contains only Harness Config values — it does not duplicate CLAUDE.md.

**Gate types**: `structural` always pauses for user confirmation. `auto` proceeds silently. Compliance failures always gate regardless of step gate type.

## Extending the Harness

**New workflow**: add `workflows/<name>.md` with frontmatter (`name`, `description`, `trigger`) and a `## Steps` list. Each step needs: `name`, `agent`, `gate`, `rules`, `description`. Optional step fields:

- `artifact: <path>` — the step writes its primary output to this file (under `.ewh-artifacts/`). The dispatcher appends a write instruction to the agent's `## Task` section. Downstream steps use `reads:` to consume it.
- `reads: [<path>, ...]` — files the agent must read before starting. The dispatcher injects a `## Required Reading` section into the prompt listing these paths. Use for artifact handoff between steps.
- `requires:` — preconditions evaluated before the step runs. If any fail, the step is skipped with a log entry. Two forms:
  - `prior_step: <name>` + `has: <field>` — the named prior step's summary must contain a non-empty value for that field (e.g., `files_modified`)
  - `file_exists: <path>` — the file must exist on disk (typically an artifact from a prior step)
- `context: [{step: <name>, detail: raw|full|summary}, ...]` — declares which prior steps the agent receives under ## Prior Steps and at what compression level. `full` (~5-10 bullets with decisions and file detail), `summary` (1-3 bullets + file list), `raw` (uncompressed agent output). Steps not listed are excluded. If omitted or empty, the agent gets no ## Prior Steps section.
- `chunked: true` — enables proactive chunked dispatch for steps that fan out across many files. On first run, the dispatcher prompts the user for include/exclude glob patterns and stores them in `.claude/ewh-state.json` keyed by `<workflow>/<step>`. On subsequent runs, cached patterns are reused. The dispatcher enumerates matching files, splits them into chunks (default 8 files per chunk), spawns parallel workers, and merges results into the step's artifact. If the file count is ≤ `max_per_chunk`, the step runs as a normal single agent. See dispatcher §1c for full flow.
- `script: <path>` — path to a pre-defined Bash script. If set, the dispatcher runs this script instead of spawning an agent (skipping §2–§6). If omitted, the dispatcher checks for a cached script at `.claude/ewh-scripts/<workflow>/<step>.sh`, then evaluates whether the step is scriptable. See dispatcher §1d for full flow. Mutually exclusive with `chunked: true`.
- `script_fallback: gate | auto` — controls behavior when a script fails (non-zero exit). `gate` (default): stop and offer retry/edit/agent-fallback/skip/abort. `auto`: silently fall back to the step's agent (requires `agent:` to be defined). See dispatcher §1d step 5.

**New rule**: add `rules/<name>.md` with frontmatter (`name`, `description`, `scope`, `severity`, `inject_into`, `verify`). `inject_into` is advisory metadata (not enforced — workflow `rules:` lists control injection). Set `severity: critical` and provide a `verify` shell command to trigger automatic compliance checks.

**New agent**: add `agents/<name>.md` with frontmatter (`name`, `description`, `model`, `tools`, `maxTurns`). Must include a `## Before You Start` self-gating section (verify context sufficiency, bail with `AGENT_COMPLETE` if missing) and output format instructions ending with the `AGENT_COMPLETE` sentinel instruction.

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
