---
name: dispatcher-binary-v2
type: decision
status: accepted
scope: [dispatcher, architecture, rewrite]
created: 2026-04-18
supersedes: [partial-output-handling, context-assembly-improvements, script-proposal, expand-tools, ewh-plugin-design]
---

# Dispatcher Binary v2 — Architectural Rewrite

## Understanding Summary

**What is being built.** A rewrite of EWH's dispatcher. Replaces the ~990-line `skills/doit/SKILL.md` with (a) a thin SKILL.md shim (~60 lines), and (b) a Node/TypeScript binary at `bin/ewh` that holds all orchestration state and procedural logic and emits one action at a time back to the LLM.

**Why.** The current markdown dispatcher is expensive (re-read every invocation and persisted in session context), drift-prone (LLM re-interprets control logic each run), and fragile in the procedural bits (chunked dispatch §1c, script resolution §1d, partial-output recovery §6c/§6a/§6b).

**Who for.** Solo plugin author using EWH as a daily driver inside Claude Code.

**Key constraints.**
- Claude Code plugin model preserved — `/ewh:doit <name>` still works, `Agent` tool still spawns subagents.
- Workflow/agent/rule markdown formats **unchanged**. Project overrides continue to work.
- Runtime is Node (already required by Claude Code).

**Explicit non-goals.**
- Not porting to LangGraph/Mastra/Claude Agent SDK.
- Not turning EWH into a standalone CLI outside Claude Code.
- Not adding durable execution, multi-tenancy, or distributed workflows.

## Assumptions

1. **Performance**: binary turn overhead < 500 ms typical. Not a hot path; user latency dominated by Agent calls.
2. **Scale**: single developer, one repo, ≤10 invocations/day, ≤20 steps per workflow, ≤10k files in chunked scope. No concurrency.
3. **Security/privacy**: runs local only; script cache executes user-approved Bash.
4. **Reliability**: every transition writes state atomically; crash between turns is resumable. No durable queue.
5. **Maintenance**: solo-authored, unpublished plugin. TypeScript + markdown workflows. Vitest tests.

## Decision

Adopt **Approach 1: step-by-step reactive driver** as the sole architecture.

- **Binary drives; LLM executes.** At each turn the LLM calls `ewh` (start or report), reads the emitted `ACTION:` block, executes one tool call, and reports back with a short CLI invocation. The binary reacts to each result before deciding the next action.
- **Thin SKILL.md shim** (~60 lines) is a `while` loop that invokes the binary, reads its output, executes the named action, and reports back. Pre-baked first instruction via shell injection: `` !`ewh start "$ARGUMENTS"` ``.
- **File-indirection for prompts and results.** Full agent prompts written to `.ewh-artifacts/<run-id>/step-N-prompt.md`; outer-session Agent tool call carries only the path (~30 tokens). Subagent reads the file in its own context. Results written to disk by agents; outer session sees only terse confirmations with `AGENT_COMPLETE`.
- **Plugin-bundled hook** in `hooks/hooks.json` records tool calls via `SubagentStart`/`SubagentStop` (and PostToolUse for Bash/Edit) for drift detection. Scoped by `.ewh-artifacts/<run>/ACTIVE` marker.
- **State machine with typed phases** replaces dispatcher §1–§8 prose. Every transition is a pure function `(state, report) → (newState, instruction)`. Atomic write to `.claude/ewh-state.json` before instruction emission.

### Architecture

Five components:

```
SKILL.md shim (~60 lines)   ← LLM reads this
     │ stdin/stdout
     ▼
ewh binary (Node/TS)        ← orchestration state, procedural logic
     │ reads              │ reads/writes
     ▼                      ▼
workflows/, agents/,       .claude/ewh-state.json
rules/ (markdown,          .ewh-artifacts/<run-id>/
 unchanged)                  ├── state.json
                             ├── step-N-*.md
                             └── turn-log.jsonl
```

**LLM's job**: run the tool call the binary names; run `ewh report` to hand back results.

**Binary's job**: everything else — workflow parse, rule load, prompt build, sentinel detect, continuation/split/merge, gate decisions, compliance checks, state persistence.

### Turn Protocol

Two binary commands:

- `ewh start "<raw argv>"` — begins a run, returns first instruction + `run_id`.
- `ewh report --run <id> --step <id> --result <path> [--error ...|--decision <yes|no>|--abort]` — reports result, returns next instruction or `ACTION: done`.

Every instruction block has the shape:

```
ACTION: <tool-call | user-prompt | bash | done>
<body — what to do, prose>
REPORT_WITH: ewh report --run <id> --step <id> [flags]
```

Example emitted by binary for a coder step:

```
ACTION: tool-call
Tool: Agent
Args:
  subagent_type: coder
  prompt: |
    Read /abs/path/.ewh-artifacts/run-1234/step-2-prompt.md and follow it.
  description: "add-feature: code"
After the tool returns, save the final assistant message to
  .ewh-artifacts/run-1234/step-2-output.md
REPORT_WITH: ewh report --run 1234 --step 2 --result .ewh-artifacts/run-1234/step-2-output.md
```

**Token cost per step (with file-indirection): ~400 tokens outer session** vs. current ~5k tokens. Plus the SKILL.md shim at ~150 tokens vs. current ~4k persisting for the whole session.

### Binary Internals — State Machine

State is a discriminated union keyed by `phase`:

```ts
type StepState =
  | { phase: 'pending' }
  | { phase: 'precondition_failed'; reason: string }
  | { phase: 'gate_pending'; prompt: string }
  | { phase: 'script_eval' }
  | { phase: 'script_propose'; script: string; rationale: string }
  | { phase: 'script_run'; script_path: string; attempts: number }
  | { phase: 'chunk_plan'; files: string[]; chunks: string[][] }
  | { phase: 'chunk_running'; chunk_index: number; total: number; completed: boolean[] }
  | { phase: 'chunk_merge' }
  | { phase: 'agent_run'; prompt_path: string; result_path: string; retries: number }
  | { phase: 'continuation'; partial_path: string }
  | { phase: 'split'; chunks: SplitChunk[]; completed: boolean[] }
  | { phase: 'split_merge' }
  | { phase: 'artifact_verify' }
  | { phase: 'compliance'; critical_rules: Rule[] }
  | { phase: 'complete'; summary: StepSummary }
  | { phase: 'skipped'; reason: string };
```

Current dispatcher section → phase:

| Section | Phase(s) |
|---|---|
| §1 precondition | check in `pending → precondition_failed / gate_pending` |
| §1b gate | `gate_pending` |
| §1c chunked | `chunk_plan → chunk_running → chunk_merge` |
| §1d scripts | `script_eval → script_propose → script_run` |
| §2+§2b+§3+§4+§4b | `agent_run` prep (pure functions) |
| §6 collect sentinel | `agent_run → (complete | continuation)` |
| §6c continuation | `continuation` |
| §6a split | `split` |
| §6b merge | `split_merge` |
| §6e artifact verify | `artifact_verify` |
| §7 compliance | `compliance` |
| §8 error handling | per-phase error handlers in transitions |

Source layout:

```
bin/ewh                              → shebang shim that invokes ewh.mjs
bin/ewh.mjs                          → compiled bundle (~100 KB, esbuild)
src/
  commands/{start,report,record-tool-use,status,abort,resume,doctor}.ts
  commands/{init,cleanup,create,expand-tools,list}.ts   ← subcommand migration
  state/{machine,store,types}.ts
  workflow/{parse,preconditions,prompt-builder,rule-loader}.ts
  chunking/{plan,merge}.ts
  scripts/{evaluate,cache,hash}.ts
  continuation/{detect,build-prompt,split}.ts
  hooks/{tool-use-log,drift}.ts
  instruction/emit.ts
```

Runtime deps: `yaml`, `zod`, `glob`, `picomatch`. Installed into `${CLAUDE_PLUGIN_DATA}/node_modules` via `SessionStart` hook using the documented diff-install pattern.

### Gate Model

Four gate classes, independent toggles:

| Class | When | Default | Auto-skippable? |
|---|---|---|---|
| Startup | before first step | ask | yes, via `--auto-approval` |
| Structural | per-step `gate: structural` | ask | yes, via `--trust` or persisted |
| Compliance | after `severity: critical` rule fails | **always ask** | only via `--yolo` per-invocation; never persisted |
| Error | agent crash, missing artifact, script non-zero | ask after N retries | `max_error_retries` configurable |

Persisted per-workflow in `.claude/ewh-state.json`:

```json
{
  "workflow_settings": {
    "add-feature": {
      "auto_approve_start": true,
      "auto_structural": false,
      "max_error_retries": 2
    }
  }
}
```

`auto_compliance` is intentionally **not a persisted field**.

Flags:

| Flag | Effect |
|---|---|
| `--auto-approval` / `--need-approval` | toggle `auto_approve_start` for this run |
| `--trust` | `auto_approve_start = auto_structural = true`; compliance still gates |
| `--yolo` | `--trust` + auto-skip compliance (loud log; never saved) |
| `--max-retries N` | override `max_error_retries` for this run |
| `--save` | persist applied flag values into `workflow_settings` |
| `--strict` | escalate drift detection to Level 3 (halt on mismatch) |

`--yolo --save` is rejected: compliance auto-skip cannot be persisted.

### Error Handling & Crash Recovery

Failure modes:

| Failure | Recovery |
|---|---|
| Binary crashes mid-transition | next `ewh report` re-reads state, re-emits same instruction (idempotent) |
| LLM abandons loop | `.ewh-artifacts/<run>/ACTIVE` marker persists; next `/ewh:doit` prompts resume / abort / clear |
| User says "abort" | LLM runs `ewh report --abort`; binary marks aborted, cleans up |
| Agent crashes / hits max turns | retry per `max_error_retries`; gate on exhaustion |
| Script exit ≠ 0 | `script_fallback: gate` or `auto` |
| Artifact missing after success claim | §6e gate: retry / skip / abort |
| Compliance verify fails | always gate (even `--trust`); only `--yolo` skips |
| `ewh-state.json` corruption | gate with raw error + path |

**Atomic state writes**: tmp file → fsync → rename. No partial writes.

**Drift detection**: PostToolUse + SubagentStart hooks append to `.ewh-artifacts/<run>/turn-log.jsonl`. On each `ewh report`, binary compares last-instructed tool call against log entries since last offset.

- Level 2 (default): mismatch → warn, continue.
- Level 3 (`--strict`): mismatch → gate.
- Extra tool calls (Read, Grep) do not count as drift — only the primary expected call is checked.

**New subcommands**: `ewh status`, `ewh abort`, `ewh resume`, `ewh doctor`. Each has a thin SKILL.md wrapper (`/ewh:doit status`, etc.).

### Migration Path

User-facing file formats unchanged — workflows, agents, rules, project overrides, `.claude/ewh-state.json` schema (extended), `.claude/ewh-scripts/` cached scripts, Harness Config in CLAUDE.md.

Plugin repo changes:

| Before | After |
|---|---|
| `skills/doit/SKILL.md` (~990 lines) | same path, ~60 lines (shim) |
| — | `bin/ewh`, `bin/ewh.mjs` |
| — | `hooks/hooks.json` |
| — | `src/` TS sources |
| — | `package.json` build config (tsc → esbuild) |
| — | `tests/` vitest |
| `.claude-plugin/plugin.json` v1.x | v2.0.0 |

Subcommands (`init`, `cleanup`, `create`, `expand-tools`, `list`) migrate from inline SKILL.md prose into binary commands. User experience identical.

Plugin unpublished → no external migration.

### Testing Strategy

Three layers:

1. **Unit tests (vitest)** on pure functions: state machine transitions, workflow parser, rule loader, prompt builder, preconditions, sentinel detection, split algorithm, hash staleness, drift comparator, instruction emitter. Target ≥90% on state machine, ≥80% elsewhere.
2. **Integration tests** with scripted fake LLM: happy path, each gate class, chunked, script-resolved + fallback, continuation, split-merge, crash-resume, abort, drift levels. No Claude required.
3. **End-to-end** manual via `claude --plugin-dir`. Claude Agent SDK headless mode is optional future automation.

`ewh doctor` serves as user diagnostic and CI smoke test.

### Phased Development Plan

Each phase leaves a runnable slice:

1. Scaffold + state machine + SKILL.md shim + trivial 1-step workflow
2. Single-agent step path (parse, rule load, prompt build, `agent_run → complete`)
3. Gates (structural, compliance, error-retry) + automation flags
4. Script resolution (§1d equivalent)
5. Chunked dispatch (§1c equivalent, incl. incremental agents)
6. Continuation + split + merge (§6c/§6a/§6b equivalent)
7. Hooks + drift detection (`--strict`)
8. Subcommand migration (init, cleanup, create, expand-tools, list)
9. Tests throughout
10. Docs + README update

Estimate: 2–3 weeks at ~20 hr/week for solo developer.

## Alternatives Considered

**Approach 2: Plan-once batch driver.** Binary emits full sequence of actions upfront; LLM executes in order. *Rejected* — EWH workflows branch constantly (compliance, script fallback, continuation, chunked split), and re-plan mechanism would be as complex as Approach 1 but less direct.

**Approach 3: Hybrid phase-based driver.** Binary emits a phase (non-branching sequential run) at a time. *Rejected* — existing workflows (`add-feature`, `check-fact`, `refine-feature`, `update-knowledge`) branch on almost every step; non-branching runs are 1–2 steps long. Complexity not earned.

**Bash instead of Node/TS.** *Rejected* — state is JSON- and YAML-heavy, which Bash handles poorly (`jq`, `yq`, stringly-typed). Node is already required by Claude Code; TS gives exhaustive-match checks for the state machine.

**Keep pure-markdown dispatcher and tighten prose.** *Rejected* — per-invocation token cost (~4k persisting through session) and drift risk are not solvable by rewording.

**Port to LangGraph/Mastra/Claude Agent SDK.** *Rejected* at Q4 — abandoning the Claude Code plugin model loses native IDE integration, in-session gates, conversational UX. A different product.

**Strangler pattern: binary handles procedural parts, markdown remains outer loop.** *Rejected* after shape commitment (Q3-prereq) — markdown-as-outer-loop contradicts binary-drives-control-flow; can't half-own a loop.

**SDK inside binary for reasoning calls.** *Rejected* — single-mechanism wins. Scriptability evaluation and ambiguous-gate decisions happen via Agent tool calls the binary emits. No API key management in binary.

**Per-run SQLite or subdirectory state.** *Rejected* — single-user, ≤10 invocations/day, no concurrency; extended `.claude/ewh-state.json` is sufficient. YAGNI.

**JSON wire protocol between LLM and binary.** *Rejected* — prose instructions with structured CLI args place typing where it's cheap (inside binary) and pattern-matching where LLMs excel (natural language).

**Level 3 drift detection (strict) as default.** *Rejected* — false-positive risk on benign extra Read/Grep calls. Level 2 default with `--strict` opt-in.

**Install hook via `ewh init` into `.claude/settings.json`.** *Rejected* after fact-check — plugin-bundled `hooks/hooks.json` fires only when the plugin is enabled, requires no install step, and auto-removes when plugin is uninstalled.

**Context-fork SKILL.md (run dispatcher loop in a subagent).** *Deferred* — would save more outer-session tokens but uncertain whether a subagent can itself invoke the Agent tool; not verified. Not in scope for v2.0.0.

## Acceptance Criteria

The rewrite is complete when:

1. `/ewh:doit add-feature "<desc>"` runs end-to-end with all steps, gates, and compliance checks working in a fresh test repo.
2. All four workflows (`add-feature`, `refine-feature`, `update-knowledge`, `check-fact`) produce behaviorally equivalent results to the current dispatcher, with outer-session token cost reduced by ≥5× as measured on a sample run.
3. All subcommands (`init`, `cleanup`, `create`, `expand-tools`, `list`) work with no UX regression.
4. Crash-resume works: kill binary mid-transition, next invocation resumes from the same instruction.
5. Drift detection logs mismatches (Level 2) and halts on `--strict` (Level 3) for both intentional and accidental mismatches.
6. Unit tests: ≥90% branch coverage on `state/machine.ts`, ≥80% elsewhere. Integration tests cover all state-machine branches enumerated in §Testing Strategy.
7. `ewh doctor` returns clean on a fresh clone + fresh project.
8. Existing user `.claude/ewh-state.json` files (with v1.x schema) load without error after adding the new `workflow_settings` key.
9. Plugin repo version bumps to 2.0.0 and `skills/doit/SKILL.md` is ≤80 lines.
10. All five superseded specs are marked as such in `specs/SPECS.md`.

## Superseded Specs

This spec supersedes:

- `partial-output-handling` — implemented in `src/continuation/` as `continuation`, `split`, `split_merge` phases.
- `context-assembly-improvements` — implemented in `src/workflow/prompt-builder.ts`.
- `script-proposal` — implemented in `src/scripts/{evaluate,cache,hash}.ts` as `script_eval`, `script_propose`, `script_run` phases.
- `expand-tools` — implemented as `ewh expand-tools` binary subcommand.
- `ewh-plugin-design` — packaging decisions are now covered by plugin manifest and this spec.

Prior specs should be updated to reference this spec and have their status flipped.

## Decision Log

1. **Redesign scope forced to dispatcher layer only** — per-step agent work is irreducibly LLM and out of scope. (Q2 affirmed)
2. **Runtime: Node/TypeScript**, not Bash. Token cost is identical either way (script source never enters context); Node handles JSON/YAML/glob/hash natively and gives exhaustive-match checks via discriminated unions. (Q2-answer clarification)
3. **Use case: daily driver inside Claude Code** with UX load-bearing; rules out LangGraph/Mastra pivot. (Q4 → A)
4. **Shape: binary-as-outer-loop, LLM-as-tool-executor.** Binary drives; LLM only runs named tool calls and reports results. (Q3-prereq → A)
5. **Migration posture: clean rewrite** of dispatcher layer; user-authored file formats preserved. (Forced by shape choice)
6. **Approach 1 (step-by-step reactive driver)** over plan-once batch or hybrid phases. Branch-heavy workflows make reactivity the right default. (Q5 → A)
7. **Other axes defaulted**: Agent-tool-only for reasoning calls (no SDK in binary); extend `ewh-state.json` (no SQLite); prose instructions with CLI-arg-typed data; JSON not used on the wire.
8. **Automation model: four gate classes with independent toggles.** Compliance auto-skip never persisted; `--yolo --save` rejected.
9. **Plugin-bundled `hooks/hooks.json`** over user-scoped settings — fires only when plugin is active, zero install step. (fact-check correction)
10. **Drift detection: Level 2 default (log), Level 3 via `--strict` (halt).** Extra tool calls (Read/Grep) do not count as drift.
11. **State is a discriminated union keyed by `phase`.** TypeScript forces exhaustive handling; control-flow drift becomes a build error.
12. **Every transition atomic**: write state via tmp + fsync + rename before emitting instruction. Crash-resume is free.
13. **File-indirection for prompts and results**: outer session carries only paths (~30 tokens) instead of full prompts/outputs (~5k tokens). Core token lever.
14. **Pre-baked first instruction** via SKILL.md shell injection (`` !`ewh start "$ARGUMENTS"` ``). Saves one turn.
15. **Drift logged via SubagentStart/SubagentStop** (Agent calls) and PostToolUse (Bash/Edit), not PostToolUse only. Cleaner signal.
16. **Plugin dependencies via `${CLAUDE_PLUGIN_DATA}` + `SessionStart`** diff-install pattern. State stays in project `.claude/`.
17. **Workflow/rule markdown remains at plugin root** (not an official plugin component dir but `${CLAUDE_PLUGIN_ROOT}`-relative reads work via cache copying).
18. **Four new binary subcommands**: `status`, `abort`, `resume`, `doctor`. Thin SKILL.md wrappers.
19. **Three test layers**: unit (pure functions, vitest), integration (scripted fake LLM), e2e (manual `claude --plugin-dir`). CI runs layers 1–2 only.
20. **Phased development**: 10 phases, each leaves a runnable slice.

## Open Questions

Non-blocking; resolve during implementation.

1. Can a subagent itself invoke the `Agent` tool? Answer affects whether a future `context: fork` optimization on SKILL.md is viable. Not in scope for v2.0.0.
2. Windows native support (vs. WSL only). Node is cross-platform but hooks use shell scripts — needs verification.
3. `ewh replay <run_id>` stretch-goal subcommand for replaying historical turn-logs against the current binary (refactor verification tool). Not in v2.0.0 scope.
4. Whether to extract a reusable `@ewh/core` npm package for other plugin authors to build on. Premature; revisit if there's demand.
