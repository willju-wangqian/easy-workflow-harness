# Changelog

All notable changes to Easy Workflow Harness are documented here.

## [2.0.2] - 2026-04-19

### Fixed
- `skills/doit/SKILL.md`: tell the LLM to show the `done` action body verbatim. When the binary emits `ACTION: done` with a summary body (e.g., `/ewh:doit list`'s catalog, or a workflow completion summary), the shim's previous instructions said only "exit the loop" — so the LLM would acknowledge completion but never display the body. Users saw `ACTION: done` + a vague "catalog above" stub with no actual catalog. The body is now shown verbatim before the loop exits.

## [2.0.1] - 2026-04-19

Documentation and schema cleanup. No behavior change.

### Removed
- `--auto-approval` / `--need-approval` CLI flags and the `auto_approve_start` field in `WorkflowSettings`. The v1 "startup Proceed? gate" was never ported to the v2 state machine, so these flags controlled nothing. Use `--trust` (optionally `--trust --save` to persist) for gate automation.
- `auto_approve_start` frontmatter field from `templates/workflow.md` and the four built-in workflow files (it was a no-op in v2).

### Changed
- `README.md`, `HARNESS.md`, `CLAUDE.md`: gate docs now describe the three real classes (structural, compliance, error). The "Auto-Approve Start" subsection has been deleted.
- `skills/doit/list.md` + `src/commands/list.ts` catalog: flag list now matches the binary's actual parser (`--trust`, `--yolo`, `--max-retries`, `--save`, `--strict`, `--manage-scripts`, `--manage-tasks`, `--no-override`).
- `bin/ewh` wrapper: resolve symlinks and export `CLAUDE_PLUGIN_ROOT` so `ewh` works when installed on `$PATH` via symlink.

## [2.0.0] - 2026-04-19

Complete rewrite of the dispatcher layer as a Node/TypeScript binary. User-facing workflow/agent/rule file formats are unchanged; only the orchestration engine changed.

### Changed (architecture)
- **Binary-drives-control-flow** — The ~990-line `skills/doit/SKILL.md` markdown dispatcher is replaced by a Node/TypeScript binary at `bin/ewh` (compiled via esbuild to `bin/ewh.mjs`). `SKILL.md` is now a thin shim (~60 lines) that invokes `ewh start` and loops on `ewh report`. Binary holds all orchestration state; LLM executes one named tool call per turn and reports the result. Outer-session token cost reduced ~5× (file-indirection: agent prompts written to `.ewh-artifacts/<run-id>/step-N-prompt.md`; outer session carries only the path, ~30 tokens vs. ~5k in v1).
- **Typed state machine** — Step state is a discriminated union of 17 phases (`src/state/machine.ts`). Every transition is a pure function; TypeScript enforces exhaustive handling. No more LLM re-interpreting prose control logic on each run.
- **`ewh-state.json` schema** — `auto_approve_start` (top-level object) replaced by `workflow_settings.<name>.auto_approve_start`; `chunked_scopes` replaced by `chunked_patterns.<workflow>/<step>`. Old v1.x files load without error (backward-compatible read path; new keys added on first write).
- **Four gate classes with independent toggles** — Startup, Structural, Compliance (never auto-persisted), Error (retry-limited). New per-run flags: `--trust` (auto structural), `--yolo` (trust + compliance skip; not saveable), `--max-retries N`, `--save` (persist applied flags to `workflow_settings`), `--strict` (drift Level 3). `--yolo --save` is rejected.

### Added
- **`bin/ewh` binary** — `ewh start "<name> [args]"` begins a run; `ewh report --run <id> --step <i> [flags]` advances it. Each command emits one `ACTION:` block for the shim to execute. Builtin subcommands (`list`, `init`, `cleanup`, `create`, `expand-tools`) alias to `ewh start <name>`.
- **File-indirection for prompts and results** — full agent prompts written to disk before dispatch; outer session passes only the path. Result files likewise written by agents to disk; binary reads them on `ewh report`.
- **Plugin-bundled hooks** (`hooks/hooks.json`) — `SubagentStart`/`SubagentStop` and `PostToolUse` hooks append to `.ewh-artifacts/<run-id>/turn-log.jsonl` for drift detection. Scoped by `ACTIVE` marker; fires only when the plugin is enabled, no install step required.
- **Drift detection** — Level 2 (default): tool-call mismatch logs a warning and continues. Level 3 (`--strict`): mismatch halts with a gate. Extra Read/Grep calls do not count as drift — only the primary expected call is checked.
- **Crash-resume** — every state transition writes atomically (tmp → fsync → rename) before emitting the next instruction. If the binary crashes mid-transition, the next `ewh report` re-reads state and re-emits the same instruction. Abandoned runs leave an `ACTIVE` marker; next `/ewh:doit` invocation offers resume / abort / clear.
- **Subcommand migration** — `init`, `cleanup`, `create`, `expand-tools`, `list` migrated from inline SKILL.md prose into `src/commands/*.ts`. User experience and behavior are identical to v1.
- **Vitest test suite** — unit tests on state machine transitions, workflow parser, rule loader, prompt builder, preconditions, sentinel detection, split algorithm, hash staleness, drift comparator, and instruction emitter. Integration tests cover all gate classes, chunked dispatch, script resolution, continuation, split-merge, crash-resume, abort, and drift levels.

### Superseded specs
The following five decision specs are superseded by `dispatcher-binary-v2` and marked accordingly in `specs/SPECS.md`:
- `partial-output-handling` → implemented in `src/continuation/` as `continuation`, `split`, `split_merge` phases.
- `context-assembly-improvements` → implemented in `src/workflow/prompt-builder.ts`.
- `script-proposal` → implemented in `src/scripts/` as `script_eval`, `script_propose`, `script_run` phases.
- `expand-tools` → implemented as the `ewh expand-tools` binary subcommand.
- `ewh-plugin-design` → packaging decisions covered by plugin manifest and `dispatcher-binary-v2` spec.

## [1.0.5] - 2026-04-16

### Changed
- **Incremental artifact writes are now structural, not advisory** — scanner, reviewer, and tester agents now declare `incremental: true` in frontmatter. For chunked dispatch, the dispatcher pre-creates each chunk artifact with a header and an `<!-- APPEND ABOVE THIS LINE -->` anchor, then injects a resume-aware directive instructing the agent to `Edit`-append per finding. Previously the 1.0.1 "write incrementally" bullet was advisory; agents routinely batched output in-head and hit the turn cap before flushing anything to disk (observed: validate-chunk files containing only 163 bytes of skeleton after 27-28 tool uses). The new scheme guarantees partial progress survives turn-cap truncation.
- **Retry contract for incremental agents** — on per-chunk failure, the dispatcher skips §6c continuation and §6a split (continuation-with-same-prompt tends to repeat the same turn-cap failure) and gates the user directly: retry / skip / abort. Retry re-spawns the identical prompt; the agent's resume-aware directive reads the partial chunk file from disk and continues from where it left off. The dispatcher logs whether the chunk file has content above the anchor so the user can make an informed retry decision. Non-incremental agents keep the existing §6c/§6a flow unchanged.
- **`maxTurns` bumped** — scanner 20→30, reviewer 20→30, tester 25→30. Co-fix: the prior caps were too tight for verification workloads where Read/Grep/serena calls consume the budget quickly. Ergonomic headroom, not a correctness fix.
- **`Edit` tool added to scanner and reviewer tool lists** — required for the `Edit`-append anchor pattern. Does not enlarge effective capability: these agents already have `Bash` (unrestricted), so `Edit` is a clearer, more auditable way to do what Bash already permits.

### Added
- **`incremental: true` agent frontmatter field** — marks an agent as a list-producer (findings, review issues, test entries) eligible for the chunked-dispatch skeleton + resume machinery. Documented in root `CLAUDE.md` and `docs/subcommand-create.md`.

### Docs
- **README** — corrects dispatcher file count (SKILL.md + list.md, not one file); moves `/ewh:doit list` into the subcommands section; notes that tester also carries `Edit` alongside scanner and reviewer.
- **docs/customization.md** — adds `chunked`, `script`, and `script_fallback` to the step fields reference table (were missing despite being implemented since 1.0.3).
- **docs/testing-overrides.md** — fixes stale step names in Check 5 (`explore`/`implement` → `plan`/`code`).
- **docs/workflow-check-fact.md** — adds `Chunked: true` to scan-docs and validate step descriptions.
- **docs/expand-agent-tools.md** — reinstall warning now includes `name: <name>` alongside `extends: ewh:<name>`; without `name:` the override silently falls back to the unexpanded plugin agent (the 1.0.4 fix).

## [1.0.4] - 2026-04-16

### Changed
- **`list` is now a built-in subcommand** — same invocation (`/ewh:doit list` or `/ewh:doit` with no args), but the catalog content lives in `skills/doit/list.md` and is printed verbatim. The dispatcher appends a lightweight footer listing project override names (workflows, rules, agents) when any exist. Saves tokens and keeps the source of truth for the built-in catalog in one place.

### Fixed
- **`expand-tools` generates registrable overrides** — the Phase 5 template now includes `name: <agent_name>` in addition to `extends:` and `tools:`. Previously, generated override files registered nothing as a subagent type, so the dispatcher's `subagent_type: "<name>"` call would fail and retry with `ewh:<name>`, silently spawning the plugin agent with its **unexpanded** tool list — defeating the expansion. To heal existing overrides generated by earlier versions, rerun `/ewh:doit expand-tools` → "Regenerate overrides".

## [1.0.3] - 2026-04-16

### Changed
- **Subcommands replace five workflows** — `init`, `cleanup`, `create-rules`, `create-agents`, and `create-workflow` are now built-in subcommands handled directly by the dispatcher instead of full workflows. Subcommands skip the workflow machinery (agents, rules, compliance, artifacts) for faster execution and lower token usage.
- **`init` subcommand** — same project bootstrap behavior plus a new onboarding summary that lists all available workflows, subcommands, and flags with usage context.
- **`cleanup` subcommand** — runs user-configured cleanup tasks stored in `ewh-state.json` under `cleanup_tasks`. Replaces the old workflow; no longer invokes `update-knowledge` (run that separately). Configure tasks via `--manage-tasks`.
- **Unified `create` subcommand** (`/ewh:doit create [rule|agent|workflow]`) — replaces the three scaffold workflows. The dispatcher gathers requirements interactively, validates against templates in `templates/`, and writes the file directly.
- **Name resolution order** — project workflow override → built-in subcommand → plugin workflow. Project workflows can shadow subcommand names; `--no-override` forces the built-in subcommand.

### Added
- **`--no-override` flag** — forces the built-in subcommand when a same-name project workflow exists in `.claude/workflows/`. No-op when no override exists.
- **`--manage-tasks` flag** — enters cleanup task configuration mode with LLM-assisted project scanning. Use with `/ewh:doit cleanup --manage-tasks`.
- **Validation templates** (`templates/rule.md`, `templates/agent.md`, `templates/workflow.md`) — structured templates with required fields, body structure, and validation checklists used by the `create` subcommand.
- **Subcommand reference docs** (`docs/subcommand-init.md`, `docs/subcommand-cleanup.md`, `docs/subcommand-create.md`).

### Removed
- **Five workflow files**: `workflows/init.md`, `workflows/cleanup.md`, `workflows/create-rules.md`, `workflows/create-agents.md`, `workflows/create-workflow.md` — replaced by subcommands.
- **Five workflow docs**: `docs/workflow-init.md`, `docs/workflow-cleanup.md`, `docs/workflow-create-rules.md`, `docs/workflow-create-agents.md`, `docs/workflow-create-workflow.md` — replaced by subcommand docs.

## [1.0.2] - 2026-04-16

### Added
- **Script proposal** (`script:` and `script_fallback:` step fields) — the dispatcher detects when workflow steps can be executed as Bash scripts instead of LLM agents and proposes scripts to the user. Approved scripts are cached in `.claude/ewh-scripts/<workflow>/<step>.sh` and reused on subsequent runs. Staleness detection via sha256 hash of step description. Full collaboration loop: approve / reject / edit / regenerate with guidance. See dispatcher §1d.
- **Consecutive step merging** — when multiple adjacent scriptable steps have no structural gates, critical rules, or intra-group data dependencies between them, the dispatcher offers to merge them into a single combined script with section markers.
- **`--manage-scripts` flag** — pre-run management of cached scripts: view / edit / delete / regenerate for any workflow's cached scripts. See dispatcher §4c.
- **`script_fallback:` step field** — controls behavior on script failure: `gate` (default) stops and offers retry/edit/agent-fallback/skip/abort; `auto` silently falls back to the step's agent.
- **`expand-tools` subcommand** (`/ewh:doit expand-tools`) — discovers available MCP/plugin/CLI tools, proposes per-agent assignments based on user intent, persists config in `.claude/ewh-state.json` under `agent_tools`, and generates `.claude/agents/<name>.md` override files that survive plugin reinstalls. Supports full lifecycle: add, remove, regenerate overrides, clear all.

## [1.0.1] - 2026-04-16

### Added
- **Chunked dispatch** (`chunked: true` step field) — proactive fan-out for steps that scan many files. On first run, the dispatcher prompts the user for include/exclude glob patterns and caches them in `.claude/ewh-state.json` under `chunked_scopes`. Subsequent runs reuse cached patterns. The dispatcher enumerates matching files, splits into chunks (default 8 per worker), spawns parallel agents, and merges results. Falls through to single-agent mode when file count is within budget. See dispatcher §1c.
- **Incremental artifact writes** — all five agents (scanner, reviewer, coder, tester, compliance) now write to their artifact file after each unit of work instead of batching until the end. Partial progress survives turn-limit interruptions.

### Changed
- `check-fact` workflow: `scan-docs` and `validate` steps now declare `chunked: true` so large documentation sets are processed in parallel chunks instead of a single agent pass.
- All dispatcher state (auto-approve switches + chunked-dispatch scopes) consolidated into a single `.claude/ewh-state.json` file — no separate `ewh-scopes.json`.
- `init` workflow gitignore management updated to reflect the consolidated state file.

## [1.0.0] - 2026-04-14

First stable release for marketplace publication. No dispatcher or workflow behavior changes from 0.9.3.

### Changed
- README: rewrote "Why Use This?" section to lead with lightweight / beginner-friendly / starting-point framing, tightened the discipline bullets, and added an experimental-scope note clarifying that EWH is meant to inspire users to build their own harness rather than be used as a production framework.

### Added
- README: "Extending Agent Tool Pools" subsection documenting how agent tool lists can be expanded with external MCP tool sets (Serena, GitHub MCP, etc.), pointing at `docs/expand-agent-tools.md` for the copy-paste prompt and worked example.

## [0.9.3] - 2026-04-12

### Added
- `Auto-approve start` Harness Config flag — skips only the startup "Proceed?" gate; all other gates (structural, compliance, error, artifact, context) are unaffected. Set via `/ewh:doit init` or manually in `## Harness Config`.
- 9 per-workflow reference docs under `docs/` (`docs/workflow-<name>.md`) covering steps, agents, rules, artifacts, and example outputs.
- Greedy snake example project (`examples/project_greedy_snake/`) — full project with custom `ergo` agent, `ergo-voice` rule, `add-game-feature` workflow, game source, and test suite.

### Changed
- Renamed `fact-check` → `check-fact` and `knowledge-update` → `update-knowledge` for consistent verb-noun naming across all workflows.
- `init` workflow now reminds users to add `.ewh-artifacts/` and `.claude/ewh-state.json` to other ignore files (`.dockerignore`, `.npmignore`, etc.) beyond `.gitignore`, which init manages automatically.

### Fixed
- Removed three inoperative HARNESS.md settings (`default_gate`, `compliance_enabled`, `compliance_model`) that were never consumed by the dispatcher.
- Dispatcher missing-config log message now names Easy Workflow Harness explicitly and recommends running `/ewh:doit init`.

## [0.9.2] - 2026-04-11

### Added
- Explicit `context:` field on workflow steps — replaces implicit Prior Steps heuristic. Steps now declare exactly which prior steps they receive and at what detail level (`raw`, `full`, `summary`).
- Scanner agent — dedicated read-only agent for analyzing existing code and documentation, split out from the reviewer role.
- Three scaffold workflows: `create-rules`, `create-agents`, `create-workflow` — guided creation of project-specific rules, agents, and workflows with plan, propose, create, and review steps.

### Changed
- README restructured: reference-first content order, navigational catalog, Mermaid flow diagram, "Creating Your Own" content moved to `docs/customization.md`.
- Artifact workspace path renamed from `.claude/artifacts/` to `.ewh-artifacts/` — update `.gitignore` entries in existing projects.

### Fixed
- Dispatcher no longer injects CLAUDE.md into `## Project Context` (the runtime already provides it to subagents).
- Prior Steps, rules, and Project Context are now filtered for agent relevance instead of injecting everything.
- README rewritten for beginner-friendly onboarding.

## [0.9.1] - 2026-04-11

### Added
- `artifact:` and `reads:` directives for inter-step artifact handoff.
- `requires:` preconditions on workflow steps (`prior_step` + `has`, `file_exists`).
- Agent self-gating via mandatory `## Before You Start` sections — agents bail with `AGENT_COMPLETE` when context is insufficient.
- AGENT_COMPLETE sentinel protocol for detecting partial agent output.
- Continuation flow — on partial output, spawns one retry with skip instructions.
- Split/merge flow — chunks large tasks (>30 items) into parallel batches, then merges results.
- Compliance agent — lightweight post-step auditor for `severity: critical` rules.
- Sub-workflow support with shared artifact workspace and context propagation.

### Fixed
- Artifact verification now works for non-agent executor types.
- Reviewer self-gating allows scan mode (no prior `files_modified` required).
- Seven dispatcher bugs in step sequencing, workflow resolution, and documentation accuracy.

## [0.9.0] - 2026-04-11

Initial release.

- Dispatcher (`/ewh:doit`) with workflow resolution, gate system, and prompt assembly.
- 6 workflows: `add-feature`, `refine-feature`, `check-fact`, `update-knowledge`, `clean-up`, `init`.
- 4 agents: coder, reviewer, tester, compliance.
- 4 rules: coding, review, testing, knowledge.
- Three-level project integration: zero-config, init'd, customized.
- Override resolution: project `.claude/` takes precedence for agents and workflows; rules concatenate.
- MIT license.
