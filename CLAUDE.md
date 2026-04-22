# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Easy Workflow Harness (EWH) is a Claude Code plugin that orchestrates multi-step development workflows. The plugin consists of a Node/TypeScript binary (`bin/ewh`, compiled via esbuild) plus Markdown agent/rule definitions and plugin workflow **templates**. The binary holds all orchestration logic.

Projects author their own workflows as a two-file pair at `.claude/ewh-workflows/<name>.{md,json}` (the Context Contract — see [specs/context-contract.md](specs/context-contract.md)). The JSON is machine-authoritative; the Markdown summary is rendered from it. Both files are created and edited exclusively through subcommands — `design`, `manage`, `design modify`. Plugin `workflows/*.md` files are starting-point templates that `design` reads; the runtime never executes them. `skills/doit/SKILL.md` is a thin shim that invokes the binary each turn.

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
/ewh:doit design "description"         # design a rule, agent, or workflow; workflows write a two-file pair
/ewh:doit design modify <target>       # modify an agent/rule or workflow step via LLM ferry (outer-session)
/ewh:doit manage <workflow>            # fill runtime fields (context, produces, gate, …) for a contract
/ewh:doit migrate                      # one-shot: legacy .claude/workflows/*.md → .claude/ewh-workflows/*.{md,json}
/ewh:doit expand-tools "description"   # discover and persist agent tool expansions
/ewh:doit doctor [--smoke]             # environment/config/contract health check

# Workflows (multi-step, agent-driven; require .claude/ewh-workflows/<name>.json)
/ewh:doit list                         # list available contracts and subcommands
/ewh:doit <name> "description"         # run a project contract
/ewh:doit <name> --trust               # auto-approve structural gates this run
/ewh:doit <name> --manage-scripts      # manage cached scripts before running
```

## Architecture

**Binary drives; LLM executes.** `bin/ewh` is the dispatcher. `skills/doit/SKILL.md` is a thin shim (~60 lines) that invokes `ewh start "$ARGUMENTS"` once, then loops: read the `ACTION:` block, execute the named tool call, run `ewh report` to hand back the result. All orchestration state lives in the binary; the LLM only runs tool calls and reports.

**Name resolution** (when user runs `/ewh:doit <name>`): project contract at `.claude/ewh-workflows/<name>.json` → built-in subcommand. `--no-override` forces a subcommand when a same-name project contract exists. Plugin `workflows/` is templates-only; the runtime never falls back to it. Attempting to run a workflow with no project contract errors with: "No contract found at .claude/ewh-workflows/\<name\>.json. Run /ewh:doit migrate if upgrading from the old format, or /ewh:doit design \<name\> to create one."

**Context Contract (two-file model).** Every project workflow lives as a pair under `.claude/ewh-workflows/`:

- `<name>.json` — machine-authoritative `WorkflowContract`. Runtime reads **only** this file. Every step declares `name`, `agent`, `description`, `gate` (`structural` | `auto`), `produces[]`, `context[]` (typed `{type: rule|artifact|file, ref}`), `requires[]`, `chunked`, `script`, `script_fallback`.
- `<name>.md` — human-facing summary rendered deterministically from the JSON via `src/workflow/render-md.ts`. Re-rendered after every `manage` / `design modify` apply.

Both files are machine-owned — users create and edit through subcommands:

- `design <workflow>` — TUI interview writes both files + any new-agent stubs atomically.
- `manage <workflow>` — walk each step and fill runtime fields; persists JSON and re-renders the MD.
- `design modify <workflow>:<step>` — ferry pattern: binary packages full JSON + target asset body + neighbor JSON entries + rule/artifact catalog, hands it to the outer-session LLM, receives proposed step slices, runs a structural diff + referential-integrity check, and writes atomically after approval.
- `migrate` — one-shot converter from legacy `.claude/workflows/<name>.md` to the new pair; ask-before-overwrite gate.

**Subcommands** (`init`, `cleanup`, `design`, `manage`, `migrate`, `expand-tools`, `list`, plus stateless `doctor` / `status` / `resume` / `abort`) are implemented in `src/commands/*.ts`. No agents, rules, compliance, or artifact workspace — each multi-turn subcommand is a state machine (stored in `RunState.subcommand_state`) that emits one action per turn.

**Workflows** (project contracts under `.claude/ewh-workflows/`) use the full step state machine in `src/state/machine.ts`. Each step advances through typed phases:

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
| Workflow | `.claude/ewh-workflows/<name>.json` (+ `<name>.md` summary). No plugin fallback — plugin `workflows/` is templates only. |

## Key Contracts

**AGENT_COMPLETE sentinel**: Every agent definition must instruct the agent to emit exactly `AGENT_COMPLETE` as the last line. The dispatcher uses this to detect partial output.

**Harness Config**: The `init` subcommand appends a `## Harness Config` section to the project's CLAUDE.md. The binary reads this for test commands, source patterns, etc. Agents receive it under `## Project Context`.

**Prompt assembly order**: agent template → `## Required Reading` → `## Active Rules` → `## Prior Steps` → `## Task` → `## Project Context`. Maintain this order when editing `src/workflow/prompt-builder.ts`. Under the Context Contract, each step's `context[]` entries are routed by type: `type: rule` → `## Active Rules` (resolved by filename match); `type: artifact` + `type: file` → `## Required Reading`.

**CLAUDE.md**: The Claude Code runtime automatically injects the project's CLAUDE.md into every subagent. The dispatcher's `## Project Context` section contains only Harness Config values — it does not duplicate CLAUDE.md.

**Gate types**: Three independent classes — `structural` (per-step `gate: structural`; skippable via `--trust` or `--yolo`), `compliance` (after `severity: critical` rule fails; never auto-persisted, only `--yolo` skips it for a single run), `error` (agent crash / missing artifact / script non-zero; gates after `max_error_retries` exhausted; configurable via `--max-retries N` or persisted via `--save`). `--yolo --save` is rejected.

## Extending the Harness

Authoring is done through subcommands — never hand-edit contract files. `design` is the only entry point for creating workflows, agents, and rules; `manage` fills runtime fields in an existing workflow contract; `design modify` iterates on a single step or asset.

**New workflow**: `/ewh:doit design <name>` runs an interview (per-step: `name`, `agent`, `description`), optionally adopts a plugin template as a starting point, and writes three outputs atomically:

- `.claude/ewh-workflows/<name>.json` — the contract skeleton (runtime fields default to `gate: "structural"`, `context: []`, `produces: []`, `requires: []`, `chunked: false`, `script: null`, `script_fallback: "gate"`).
- `.claude/ewh-workflows/<name>.md` — human-facing summary rendered from the JSON.
- `.claude/agents/<agent>.md` stubs for any new agent names the user supplied.

After skeleton creation, `/ewh:doit manage <name>` walks each step and fills runtime fields in order: context → produces → gate → requires → chunked → script → script_fallback. Rule picks are pre-checked from the target agent's `default_rules` frontmatter (authoring-time only; runtime reads only JSON). The `context[]` array uses typed entries:

- `{type: "rule", ref: "<name>"}` — rule filename match; concatenated under `## Active Rules`.
- `{type: "artifact", ref: "<path>"}` — must appear in some earlier step's `produces[]`; listed under `## Required Reading`.
- `{type: "file", ref: "<path>"}` — free path (escape hatch); listed under `## Required Reading`.

Other per-step runtime fields (all managed through `manage`):

- `produces: [<path>, ...]` — output slots. The first entry is the step's primary artifact (what the state machine verifies during `artifact_verify`). Convention: paths under `.ewh-artifacts/`.
- `requires: [{file_exists: <path>} | {prior_step: <name>, has: <field>}, ...]` — preconditions. If any fail, the step is skipped with a log entry.
- `chunked: true` — enables chunked dispatch for multi-file scans. On first run the binary prompts for include/exclude glob patterns (cached in `.claude/ewh-state.json` under `chunked_patterns["<workflow>/<step>"]`), splits matching files across parallel workers, and merges results via a merge agent. Mutually exclusive with `script`. Phases: `chunk_plan → chunk_running → chunk_merge`.
- `script: <path>` — run a Bash script instead of an agent. If null, the binary may propose a script at runtime if the step looks scriptable; approved scripts cache to `.claude/ewh-scripts/<workflow>/<step>.sh`. Phases: `script_eval → script_propose → script_run`.
- `script_fallback: "gate" | "auto"` — on non-zero script exit. `gate` (default) stops for retry/edit/agent/skip/abort; `auto` silently falls back to the step's agent.

To change a step later, run `/ewh:doit design modify <workflow>:<step>`. The binary ferries context (full contract JSON, neighbor step entries, target agent body, rule/artifact catalog) to the outer-session LLM, which writes self-contained step slices to `.ewh-artifacts/modify-<id>/proposed.json`. The binary runs a structural diff (update/add; explicit `"_delete": true` and `"_rename_from": "<old>"`; optional top-level `"_order": [...]`) plus referential-integrity checks, reports gaps, and writes atomically on approval.

**New rule**: `/ewh:doit design "<describe the rule>"` interviews and writes `.claude/rules/<name>.md` with frontmatter (`name`, `description`, `scope`, `severity`, `inject_into`, `verify`). `inject_into` is advisory metadata. Set `severity: critical` with a `verify` shell command to trigger automatic compliance checks after any step that lists the rule in its `context[]`.

**New agent**: `/ewh:doit design "<describe the agent>"` interviews and writes `.claude/agents/<name>.md`. Required frontmatter: `name`, `description`, `model`, `tools`, `maxTurns`. Optional: `default_rules: [<rule>, ...]` — authoring-time suggestion, pre-checked when `manage` builds the rule picker for a step that uses this agent. Optional `incremental: true` marks a list-producer agent for chunked dispatch (see above). The body must include a `## Before You Start` self-gate and end with the `AGENT_COMPLETE` sentinel. Iterate with `/ewh:doit design modify agent:<name>`.

**Project overrides**: `.claude/agents/<name>.md` replaces the plugin agent (or extends via `extends: ewh:<name>`). `.claude/rules/<name>.md` supplements (concatenated; recursive — `.claude/rules/ewh/<name>.md` and other subfolders are discovered automatically). `.claude/ewh-workflows/<name>.{md,json}` is the project-authored workflow pair; there is no concept of "overriding" a plugin workflow — plugin `workflows/*.md` are templates that `design` can seed from, and the project owns its own contract.

**Migrating legacy workflows**: if you have `.claude/workflows/<name>.md` from before the Context Contract, run `/ewh:doit migrate`. It parses each legacy YAML, maps `rules: [...]` → `{type: rule}` context, `reads: [...]` → `{type: artifact}` context, `artifact:` → `produces[]`, and preserves `gate` / `requires` / `chunked` / `script` / `script_fallback`. Old files are left in place for verification.

**Cached scripts**: `.claude/ewh-scripts/<workflow>/<step>.sh` stores approved scripts for scriptable steps. Generated when a step is identified as scriptable and the user approves the proposed script. Managed via `--manage-scripts` flag. Gitignore for developer-local preferences, or commit to share team-wide scripts.

**Doctor**: `/ewh:doit doctor` validates the plugin/project layout and every contract under `.claude/ewh-workflows/`. Fails on dangling refs (unknown rule name, artifact not produced upstream, missing agent). Warns on drift between step `{type: rule}` refs and the agent's `default_rules`, and on `workflow.md` ↔ `workflow.json` disagreement for `{name, agent}` per step.

## Harness Config

<!-- Generated by /ewh:doit init — edit values as needed -->

- Language: none (Markdown plugin)
- Test command: none
- Check command: none
- Source pattern: **/*.md
- Test pattern: none
- Doc build: none
- Conventions: frontmatter on all agent/rule/workflow files; AGENT_COMPLETE sentinel in all agent definitions
