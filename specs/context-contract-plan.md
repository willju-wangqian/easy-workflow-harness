---
name: context-contract-plan
type: plan
status: draft
scope: [subcommands, context, workflows, agents, rules, schemas]
created: 2026-04-22
tracks: context-contract
---

# Implementation Plan — Context Contract

Companion to [context-contract](context-contract.md). Six sessions, each a cohesive PR. Sessions 1–2 are the foundation — nothing else can ship without them. Sessions 3–5 add user-facing surfaces on top. Session 6 closes out. Each session's **Fresh-Session Prompt** is self-contained; paste into a new Claude Code session without prior context.

| # | Session | Scope | Roughly |
|---|---|---|---|
| 1 | Foundations | JSON schema + loader, workflow.md renderer, agent `default_rules` field | 2 h |
| 2 | Runtime reads JSON | Prompt-builder honors typed context entries; state machine loads JSON contract | 2–3 h |
| 3 | `design` rewrite | Interview → writes workflow.md + workflow.json + agent stubs | 2–3 h |
| 4 | `manage` subcommand | TUI fills runtime fields in JSON | 2 h |
| 5 | `design modify` ferry | Proposed-slice protocol, structural diff, referential integrity, re-render | 3 h |
| 6 | Doctor + migration + docs | Doctor checks for new JSON, one-shot migrator, CLAUDE.md/README updates | 1–2 h |

---

## Session 1 — Foundations

### Deliverables

- New file `src/workflow/contract.ts` exporting TypeScript types that mirror the JSON schema from the spec:
  ```ts
  export type ContextEntry =
    | { type: 'rule';     ref: string }
    | { type: 'artifact'; ref: string }
    | { type: 'file';     ref: string };

  export type ContractStep = {
    name: string;
    agent: string;
    description: string;
    gate: 'structural' | 'auto';
    produces: string[];
    context: ContextEntry[];
    requires: Array<{ file_exists: string } | { prior_step: string; has: string }>;
    chunked: boolean;
    script: string | null;
    script_fallback: 'gate' | 'auto';
  };

  export type WorkflowContract = {
    name: string;
    description: string;
    steps: ContractStep[];
  };
  ```
- New file `src/workflow/contract-loader.ts` with:
  - `async function loadContract(path: string): Promise<WorkflowContract>` — reads JSON, validates schema (shape only, not referential integrity yet), throws readable errors on malformed input.
  - `async function resolveContractPath(projectRoot: string, name: string): Promise<string | null>` — returns `.claude/ewh-workflows/<name>.json` if it exists, else `null`.
- New file `src/workflow/render-md.ts` exporting `renderWorkflowMd(contract: WorkflowContract): string`. Produces deterministic markdown: frontmatter (name + description) + `## Steps` YAML list with per-step `name`, `agent`, `description`. Repeated calls on the same contract produce byte-identical output (stable key order, no trailing whitespace, no timestamps).
- Extend `src/workflow/agent-loader.ts` to parse a new `default_rules: string[]` frontmatter field. Add it to `LoadedAgent`. Missing/invalid → `default_rules: undefined`.
- Vitest coverage:
  - `loadContract` happy path from a fixture JSON.
  - `loadContract` on malformed JSON (bad types, missing required fields) throws readable errors.
  - `renderWorkflowMd` deterministic-output test.
  - `agent-loader` parses `default_rules` when present; omits field when absent.

### Acceptance

- `npm run typecheck` clean.
- `npm test` passes including all new tests.
- **No wiring into `prompt-builder.ts`, `state/machine.ts`, or any subcommand.** This session is pure additions.
- `grep -r "default_rules"` shows it in `agent-loader.ts`, tests, and this plan — nowhere else yet.

### Fresh-Session Prompt

> I'm implementing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 1 of 6: Foundations**.
>
> **Read first, in order:**
> 1. `specs/context-contract.md` — the decision spec (full design). Focus on sections "Decision §1 (two-file representation)" and "Decision §2 (typed context entries)".
> 2. `specs/context-contract-plan.md` — this plan, especially Session 1 deliverables and acceptance.
> 3. `CLAUDE.md` — EWH architecture overview.
> 4. `src/workflow/agent-loader.ts` — you'll be extending this.
> 5. `src/workflow/rule-loader.ts` — read as reference for the loader pattern (splitFrontmatter, YAML.parse, typed-field extraction).
> 6. `src/workflow/parse.ts` — another loader reference; note how `parseStringArray` handles list fields.
> 7. `package.json` — confirm the `yaml` package is available.
>
> **Scope of this session (do not exceed):**
> 1. Create `src/workflow/contract.ts` exporting `ContextEntry`, `ContractStep`, `WorkflowContract` types exactly as specified in the plan's "Deliverables" block.
> 2. Create `src/workflow/contract-loader.ts` with:
>    - `loadContract(path)` — reads JSON, validates shape, throws readable errors. Validation checks: top-level `name` + `steps` exist; each step has all required fields with correct types; `context` entries have valid `type` values. It does NOT check referential integrity (does the rule file exist, is the artifact produced upstream) — that's Session 6 (doctor).
>    - `resolveContractPath(projectRoot, name)` — returns `.claude/ewh-workflows/<name>.json` if the file exists, else `null`.
> 3. Create `src/workflow/render-md.ts` with `renderWorkflowMd(contract)`. Must be deterministic: same input → byte-identical output on every call. Stable key ordering in YAML (name, agent, description per step). No trailing whitespace.
> 4. Extend `src/workflow/agent-loader.ts`: parse `default_rules: string[]` from agent frontmatter into `LoadedAgent.default_rules?: string[]`. Use the existing `parseStringArray` helper pattern.
> 5. Add vitest coverage in `tests/`:
>    - `tests/contract-loader.test.ts` — happy path + 3 malformed-input cases (bad top-level, bad step field type, bad context type).
>    - `tests/render-md.test.ts` — determinism (call twice, assert `===`) + shape (frontmatter present, `## Steps` present, step fields present).
>    - `tests/agent-loader.test.ts` (or append to existing) — agent with `default_rules` → parsed; agent without → `undefined`.
>
> **Do not:**
> - Touch `src/workflow/prompt-builder.ts`.
> - Touch `src/state/machine.ts`.
> - Touch any file in `src/commands/`.
> - Create any new subcommand.
> - Write the workflow.md renderer's output to disk anywhere (that's Session 3).
> - Add any referential-integrity checks in `loadContract` (that's Session 6).
>
> **Verify before reporting done:**
> - `npm run typecheck` clean.
> - `npm test` passes including all new tests.
> - `grep -rn "WorkflowContract\|ContextEntry\|ContractStep\|renderWorkflowMd\|default_rules" src/` shows them only in `src/workflow/contract.ts`, `src/workflow/contract-loader.ts`, `src/workflow/render-md.ts`, `src/workflow/agent-loader.ts` — nowhere else yet.
> - New files are the only files modified beyond `agent-loader.ts` and (optionally) an existing test file.

---

## Session 2 — Runtime Reads JSON

### Deliverables

- `src/workflow/prompt-builder.ts` updated to consume typed context entries from the contract:
  - When context comes from a JSON contract, group entries by `type`:
    - `type: 'rule'` → resolve via existing `rule-loader.ts` filename-match → concatenate under `## Active Rules`.
    - `type: 'artifact'` or `type: 'file'` → concatenate paths under `## Required Reading`.
  - Existing YAML-sourced path continues to work for backward compatibility this session.
  - Section order unchanged: agent template → `## Required Reading` → `## Active Rules` → `## Prior Steps` → `## Task` → `## Project Context`.
- `src/state/machine.ts` (or wherever workflow loading happens — likely `src/commands/start.ts`):
  - On workflow resolution, try JSON contract first (`resolveContractPath` from Session 1). If found, load as `WorkflowContract` and feed it to the step runner.
  - If no JSON, fall back to existing YAML loader. This fallback is **transitional** — Session 6 removes it.
  - Internal representation: unify under a single `Step`-like shape so downstream code doesn't branch per source. Either extend the existing `Step` type to carry typed context, or introduce an adapter that converts `WorkflowContract` → existing `Step[]`.
- Unit tests:
  - Prompt assembly from a JSON contract with a mix of `rule` / `artifact` / `file` entries — assert each lands in the correct section.
  - State machine: given a project with both `.claude/ewh-workflows/foo.json` and `.claude/workflows/foo.md`, asserts JSON wins.
  - Backward-compat: project with only old `workflows/foo.md` still runs through the YAML path.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- Existing workflows (plugin templates under `workflows/`) continue to execute unchanged via the YAML fallback.
- A hand-authored `.claude/ewh-workflows/add-feature.json` (fixture) runs end-to-end through at least the first step's prompt assembly.
- No subcommand has been added yet.

### Fresh-Session Prompt

> I'm continuing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 2 of 6: Runtime Reads JSON**. Session 1 is complete — `src/workflow/contract.ts`, `contract-loader.ts`, `render-md.ts` exist and tests pass; `agent-loader.ts` understands `default_rules`.
>
> **Read first:**
> 1. `specs/context-contract.md` — § 2 (typed context entries) and § 8 (doctor extensions, for context on referential integrity that's NOT our job here).
> 2. `specs/context-contract-plan.md` — Session 2 acceptance.
> 3. `src/workflow/contract.ts` + `contract-loader.ts` + `render-md.ts` — what Session 1 built.
> 4. `src/workflow/prompt-builder.ts` — what you'll modify. Note the existing section order at lines ~51–94.
> 5. `src/workflow/rule-loader.ts` — the filename-match resolver you'll reuse for `type: 'rule'` entries.
> 6. `src/state/machine.ts` and `src/commands/start.ts` — workflow-loading entry points.
> 7. `src/state/types.ts` — the `Step` type; you'll decide whether to extend it or adapt.
>
> **Scope of this session:**
> 1. Update `src/workflow/prompt-builder.ts` to honor typed context entries:
>    - Accept a new input shape (or adapt through the existing `Step` type) that carries `context: ContextEntry[]`.
>    - Group entries by type at assembly time: `'rule'` → resolve via `loadRulesForStep`-style filename match (reuse existing loader), concatenate under `## Active Rules`. `'artifact'` and `'file'` → paths under `## Required Reading`.
>    - Preserve the existing section order exactly.
>    - Keep the existing YAML-sourced path working.
> 2. Extend the workflow-loading path in `src/commands/start.ts` (or the matching entry point):
>    - Call `resolveContractPath` from Session 1; if a JSON contract exists, load it via `loadContract`.
>    - Feed the contract into the step runner through whatever conversion is cleanest. Prefer adapting the contract to the existing `Step` type over introducing a parallel type — one representation for downstream code.
>    - If no JSON contract exists, fall back to the existing YAML loader unchanged. Log a one-line debug note identifying which path was taken.
> 3. Unit tests:
>    - Prompt assembly: fixture JSON contract with one of each context type; assert sections are populated correctly.
>    - State machine: fixture project containing both JSON and YAML for the same workflow name → JSON wins.
>    - Backward-compat: fixture project with only YAML → still loads and runs.
>
> **Do not:**
> - Add any subcommand (`design`, `manage`, or otherwise). Those are later sessions.
> - Add referential-integrity checks (the doctor catches those in Session 6).
> - Remove the YAML fallback — that happens in Session 6.
> - Touch `agent-loader.ts` beyond what Session 1 already did.
>
> **Verify before reporting done:**
> - `npm run typecheck` clean; `npm test` passes including new tests.
> - Manual smoke: write a fixture `.claude/ewh-workflows/hello.json` and run `node bin/ewh.mjs start hello` in a throwaway project directory — confirm the dispatcher picks the JSON path.
> - Same smoke with only `workflows/hello.md` (plugin template) — confirm YAML fallback still works.

---

## Session 3 — `design` Rewrite (produces the two-file pair)

### Deliverables

- Restructure `src/commands/design.ts` (existing subcommand) OR add a new flow that:
  - Conducts a step-by-step TUI-style interview: for each step, ask `name`, `agent`, `description`. Repeat until user signals done.
  - If the user's initial description is close to a plugin workflow template, read the template and offer it as a starting point (accept/reject gate).
  - Writes three outputs:
    - `.claude/ewh-workflows/<name>.md` (rendered via `renderWorkflowMd` from Session 1).
    - `.claude/ewh-workflows/<name>.json` (skeleton: step order + agent + description; all runtime fields at safe defaults — `context: []`, `produces: []`, `gate: "structural"`, `requires: []`, `chunked: false`, `script: null`, `script_fallback: "gate"`).
    - For any new agent the user named that doesn't exist yet: stub `.claude/agents/<agent>.md` with minimal frontmatter + body derived from the user's step description.
  - Atomic across all outputs: if any write fails, roll back.
- Existing `design` subcommand behavior preserved for agent/rule creation — only the workflow flow changes shape.
- `SubcommandState` variants updated in `src/state/types.ts` for the new interview phases.
- Unit tests:
  - Interview flow: mocked AskUserQuestion responses drive full path to skeleton generation.
  - Template matching: given a description containing workflow-template keywords, offered template matches expected plugin file.
  - Output correctness: resulting JSON validates via `loadContract`; resulting md re-parses to the same contract.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- Manual: `/ewh:doit design my-first-workflow` in a fresh project produces all three outputs and they pass `loadContract` without error.
- If user accepts a plugin template, outputs mirror the template's shape.
- Plugin `workflows/` / `agents/` / `rules/` remain templates — `design` reads them, does not execute them.

### Fresh-Session Prompt

> I'm continuing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 3 of 6: `design` Rewrite**. Sessions 1–2 complete — contract types, loader, renderer, and prompt-builder JSON path all work.
>
> **Read first:**
> 1. `specs/context-contract.md` — § 4 (design interview) and § 3 (templates).
> 2. `specs/context-contract-plan.md` — Session 3 acceptance.
> 3. `src/commands/design.ts` — current design subcommand. You're restructuring the workflow-creation flow; keep agent/rule creation behavior.
> 4. `src/commands/design-catalog.ts` — catalog builder you can reuse for template matching.
> 5. `src/workflow/contract.ts`, `contract-loader.ts`, `render-md.ts` — Session 1 foundations.
> 6. `src/state/types.ts` — `SubcommandState` variants; you'll add new phases.
> 7. `workflows/add-feature.md` — a plugin template you'll read as input.
>
> **Scope of this session:**
> 1. Update `SubcommandState` in `src/state/types.ts` with new `design` phases for the workflow-creation interview (e.g., `design_workflow_interview`, `design_workflow_template_gate`, `design_workflow_write`). Keep existing `design` phases for agent/rule paths.
> 2. In `src/commands/design.ts`, when the user's target is a workflow:
>    - Run the step-by-step interview (name, agent, description per step; loop with a "propose now" option).
>    - Match against plugin templates via catalog; if ≥1 match, offer as starting point in a gate.
>    - On final approval, write all three outputs atomically. Order: rules (none here), agents (stubs), then workflow md + json. Atomic means: all writes succeed or none persist.
> 3. Agent stub generation: when the user references an agent name that doesn't exist under `.claude/agents/` or `agents/`, create a minimal stub with frontmatter (`name`, `description`, `model: sonnet`, `tools: [Read, Write]`, `default_rules: []`) + body containing the user's step description + standard `AGENT_COMPLETE` sentinel. Mark the stub clearly so the user knows it's a starting point.
> 4. Unit tests: mocked interview → skeleton JSON; template offer → matched path; output round-trip (`renderWorkflowMd` output re-parses to the same contract).
>
> **Do not:**
> - Implement `manage` (Session 4).
> - Implement `design modify` ferry (Session 5).
> - Remove or change the existing agent/rule design paths.
> - Touch prompt-builder or state-machine runtime reads.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - Manual smoke: `/ewh:doit design test-wf` in a throwaway project produces three files that all parse cleanly. Deleting any one and re-running atomically replaces all three.

---

## Session 4 — `manage` Subcommand

### Deliverables

- New file `src/commands/manage.ts`:
  - `startManage(opts)` / `reportManage(state, report)` matching existing subcommand pattern.
  - Loads the workflow contract via `loadContract` (Session 1). If no contract, emit `done` with instruction to run `design` first.
  - Per-step TUI: asks about `context` (multi-select from catalog — rules + upstream-produced artifacts + free path entry), `produces`, `gate`, `requires`, `chunked`, `script`, `script_fallback`.
  - Pre-select defaults: for `context`, pre-check `default_rules` from the step's agent; user can uncheck.
  - Catalog: rules from `rules/` + `.claude/rules/`; artifacts = `produces` declarations from earlier steps in the same workflow.
  - On completion: atomic JSON write; re-render workflow.md from the updated contract.
- `SubcommandState` variants for `manage` in `src/state/types.ts`.
- Wire into `src/commands/start.ts` dispatch and `src/commands/list.ts` listing.
- Unit tests:
  - Full TUI flow reaches atomic write.
  - Idempotence: running manage twice on the same state → byte-identical JSON.
  - Default pre-selection: agent with `default_rules: [coding]` → `coding` pre-checked for that step.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- Manual: after Session 3's `design` run, `/ewh:doit manage test-wf` cycles through every step and writes runtime fields back into the JSON.
- workflow.md updates to reflect any step-field changes relevant to the summary.

### Fresh-Session Prompt

> I'm continuing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 4 of 6: `manage` Subcommand**. Sessions 1–3 complete — foundations, runtime reads JSON, `design` writes skeletons.
>
> **Read first:**
> 1. `specs/context-contract.md` — § 6 (manage subcommand).
> 2. `specs/context-contract-plan.md` — Session 4 acceptance.
> 3. `src/commands/cleanup.ts` — subcommand-state-machine pattern to mirror.
> 4. `src/commands/design.ts` — post-Session-3 structure.
> 5. `src/workflow/contract-loader.ts` — you'll load + write contracts here.
> 6. `src/workflow/render-md.ts` — you'll re-render after every JSON update.
> 7. `src/workflow/agent-loader.ts` — read `default_rules` for pre-selection.
>
> **Scope of this session:**
> 1. Add new `SubcommandState` variant(s) for `manage` in `src/state/types.ts` — at minimum a `step_index` and a sub-phase per runtime field being asked.
> 2. Create `src/commands/manage.ts` with `startManage` / `reportManage`. State machine walks each step of the loaded contract and, for each, asks about every runtime field via `AskUserQuestion` (or the equivalent user-prompt action). Ordering: context → produces → gate → requires → chunked → script → script_fallback.
> 3. Catalog for context picker:
>    - Rules: every `.md` under `rules/` + `.claude/rules/`.
>    - Artifacts: every path in `produces[]` of steps earlier than the current step.
>    - Free path: escape hatch — let user enter a literal path string.
> 4. Default pre-selection: when presenting the rule picker for step N, read step N's agent's `default_rules`; pre-check those entries.
> 5. On completion: atomic JSON write, then call `renderWorkflowMd` and write the result to `.claude/ewh-workflows/<name>.md`.
> 6. Wire into `src/commands/start.ts` and `src/commands/list.ts`.
> 7. Unit tests: full flow to write; idempotence; pre-selection correctness.
>
> **Do not:**
> - Implement `design modify` (Session 5).
> - Touch the existing runtime path beyond what's needed to call `renderWorkflowMd`.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - Manual smoke: after `design` creates a skeleton, `manage` cycles all runtime fields and writes a JSON that passes `loadContract`.

---

## Session 5 — `design modify` Ferry + Diff

### Deliverables

- New `design modify <something>` entry point in `src/commands/design.ts` (or a new `design-modify.ts` module routed by dispatch).
- State machine ferry path:
  - On start: build the context package per spec § 5 (full workflow JSON + target agent/rule .md body + neighbor JSON entries + catalog of rule names and declared artifacts).
  - Emit an `outer-session-llm` action type (new action kind — extend the emit/instruction layer). Action payload points the outer session at `.ewh-artifacts/modify-<id>/context.md` (assembled context) and `.ewh-artifacts/modify-<id>/proposed.json` (output slot).
  - On report that `proposed.json` exists: run structural diff + referential-integrity check.
- Structural diff module in `src/workflow/contract-diff.ts`:
  - Input: current contract + array of proposed step slices + optional top-level `_delete` / `_rename_from` / `_order` markers.
  - Output: `DiffResult` = `{ updated: [...], added: [...], deleted: [...], renamed: [{from, to}], reordered: boolean, integrity_issues: [...] }`.
  - Rename preserves cross-step `context` refs that named the old step.
- Referential integrity: every new `ref` in proposed slices must resolve (rule file exists / artifact produced by an earlier step in the merged order / file exists on disk).
- Gap-report + approval loop: diff + integrity-issues rendered back to outer session for "warn and propose updates"; user approves or iterates.
- On approve: atomic merged-JSON write, then `renderWorkflowMd` → workflow.md.
- Unit tests:
  - Diff: update, add, delete, rename, reorder — each in isolation and combined.
  - Rename preserves context refs.
  - Integrity: missing rule file, missing artifact producer, dangling agent ref — each caught.
  - Merge atomicity: crash between proposed→approved should leave current JSON untouched; re-run resumes from the proposed file.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- Manual: `/ewh:doit design modify <wf>:code` prompts outer session, accepts a proposed.json, reports a diff, and on approve updates both files.
- Renaming step `code` → `implement` in one modify session preserves the `review` step's `context` ref to `code`'s output.
- Rejecting the gap report cleanly reverts without partial writes.

### Fresh-Session Prompt

> I'm continuing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 5 of 6: `design modify` Ferry + Diff**. Sessions 1–4 complete — foundations, runtime reads JSON, `design` creates skeletons, `manage` fills runtime fields.
>
> **Read first:**
> 1. `specs/context-contract.md` — § 5 (the ferry pattern in full) and the Decision Log rows for Q8, Q9, Q10.
> 2. `specs/context-contract-plan.md` — Session 5 acceptance.
> 3. `src/commands/design.ts` — current design command structure.
> 4. `src/workflow/contract.ts`, `contract-loader.ts` — types you'll diff against.
> 5. `src/instruction/emit.ts` — how actions are emitted to the outer session; you'll add a new action kind.
> 6. `src/state/store.ts` — atomic-write pattern to mirror for merged JSON.
>
> **Scope of this session:**
> 1. Add a new action kind for `outer-session-llm` in the instruction/emit layer (or reuse `tool-call` if appropriate — check existing patterns; if reused, the dispatcher-side distinguishes via payload). The action points the outer session at two files: `context.md` (read) and `proposed.json` (write target).
> 2. New module `src/workflow/contract-diff.ts`:
>    - `diffContract(current, proposed)` accepting the merge semantics from spec Q9-C: implicit set-difference for update/add; explicit `"_delete": true` per slice for removal; explicit `"_rename_from": "<old>"` per slice for rename; optional top-level `"_order": [...]` for reorder.
>    - Returns a `DiffResult` with `updated / added / deleted / renamed / reordered / integrity_issues` fields.
>    - Rename: when applying the merge, rewrite every `{type: "artifact"}` ref that named the old step's produces path, and every downstream reference — ensure context-ref preservation.
>    - Integrity: verify every new `{type: "rule"}` ref resolves in `rules/` or `.claude/rules/`; every `{type: "artifact"}` ref appears in some earlier step's `produces` in the merged contract; every new agent name in proposed slices resolves to an existing agent .md.
> 3. Extend `src/commands/design.ts` with the `modify` path:
>    - Parse `<something>` as `<workflow>:<step>` or `agent:<name>` or `rule:<name>`.
>    - Build context package under `.ewh-artifacts/modify-<id>/context.md`.
>    - Emit the ferry action.
>    - On report (proposed.json written): run diff + integrity, emit user-prompt with the summary.
>    - On approve: merge, atomic JSON write, re-render workflow.md.
>    - On reject / iterate: discard proposed.json, re-emit ferry action (or transition to done).
> 4. Unit tests: diff each op type; rename preserves refs; integrity catches each violation type; merge atomicity (simulate crash between write stages).
>
> **Do not:**
> - Remove the YAML fallback in the runtime (Session 6).
> - Build the cross-session draft persistence feature — contract lives only under `.ewh-artifacts/modify-<id>/` per spec Q11-A.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - Manual smoke with a canned proposed.json that renames a step: downstream `context` refs to the old name update correctly, merged JSON passes `loadContract`, and workflow.md re-renders.

---

## Session 6 — Doctor + Migration + Docs + Cleanup

### Deliverables

- `src/commands/doctor.ts` extensions (spec § 8):
  - New check that walks every `.claude/ewh-workflows/*.json`. For each contract: validate shape (via `loadContract`); verify every `context[].ref` resolves; warn on `default_rules` drift; warn on `workflow.md` ↔ JSON disagreement of `{name, agent}`.
- One-shot migrator:
  - New subcommand or `ewh doctor --migrate` flag (pick one; cleaner as a subcommand: `src/commands/migrate.ts`).
  - Walks `.claude/workflows/*.md` (old YAML location); for each: parses, converts to `WorkflowContract` (with best-effort mapping of `rules:` → `{type: rule}` entries, `reads:` → `{type: artifact}`, `context:` → prior-step refs), writes `.claude/ewh-workflows/<name>.{md,json}`.
  - Prompts user before overwriting anything; leaves old YAML in place (user can delete after verifying).
- Remove the YAML fallback in runtime (state machine / prompt-builder) now that migration exists.
- Update `CLAUDE.md`:
  - Architecture section: replace YAML-centric description with the two-file model.
  - Commands section: add `manage` and `design modify`.
  - "Extending the Harness": rewrite to describe the new authoring flow.
- Update `README.md` if it references old command shapes.
- Integration test `tests/integration-context-contract.test.ts` — full authoring round-trip: `design` creates skeleton → `manage` fills fields → state machine runs a step with JSON-sourced context → `design modify` renames a step → runtime still works.

### Acceptance

- `npm run typecheck`, `npm test` (including new integration) pass.
- `ewh doctor` catches a dangling `{type: "rule"}` ref in a fixture; reports it with a readable line.
- `ewh migrate` converts a fixture project's old YAML workflows to the new pair cleanly.
- YAML fallback removed; `grep -rn "\.claude/workflows/" src/` finds only migrator references.
- No stale `create` / manage-context references in CLAUDE.md / README.md.

### Fresh-Session Prompt

> I'm finishing the Context Contract redesign for Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 6 of 6: Doctor + Migration + Docs + Cleanup**. Sessions 1–5 complete — foundations, runtime JSON path, `design`, `manage`, `design modify` all work. Old YAML fallback still in the runtime for backward compat.
>
> **Read first:**
> 1. `specs/context-contract.md` — § 8 (doctor extensions) and "Open Questions / Deferred" (migration framing).
> 2. `specs/context-contract-plan.md` — Session 6 acceptance.
> 3. `src/commands/doctor.ts` — existing checks; you'll add #12+.
> 4. `src/workflow/parse.ts` — old YAML parser (read for migrator logic).
> 5. `src/workflow/contract.ts`, `contract-loader.ts`, `render-md.ts` — targets for migration output.
> 6. `CLAUDE.md` — docs to update.
>
> **Scope of this session:**
> 1. Extend `src/commands/doctor.ts` with a new check walking `.claude/ewh-workflows/*.json`:
>    - `loadContract` must succeed (shape valid).
>    - Every `context[].ref`: `type: "rule"` → rule file resolves; `type: "artifact"` → some earlier step produces it; `type: "file"` → path exists.
>    - Every `agent` references an existing agent .md.
>    - Warn on drift: step's `{type: "rule"}` refs vs. its agent's current `default_rules`.
>    - Warn on `workflow.md` ↔ JSON disagreement for any step's `{name, agent}`.
> 2. New subcommand `src/commands/migrate.ts`:
>    - For each `.claude/workflows/*.md`: parse via the old YAML loader, convert to `WorkflowContract` (map `rules:` → `{type: rule, ref: <name>}`; `reads:` → `{type: artifact, ref: <path>}`; preserve `gate`, `requires`, `chunked`, `script`, `script_fallback`).
>    - Ask the user before overwriting each target. Leave old YAML in place.
>    - Emit a summary of converted files.
> 3. Remove the YAML fallback path from runtime (state machine / prompt-builder). Any project without a JSON contract now errors cleanly: "No contract found at .claude/ewh-workflows/<name>.json. Run /ewh:doit migrate if upgrading from the old format, or /ewh:doit design <workflow> to create one."
> 4. Update `CLAUDE.md`:
>    - Architecture: replace the YAML-workflow description with the two-file model. Mention `design`, `manage`, `design modify`.
>    - Commands: add `manage` and `design modify`.
>    - Extending the Harness: rewrite "New workflow" / "New rule" / "New agent" sections to reflect the new authoring flow (`design` is the only entry point).
> 5. Update `README.md` if it references old command shapes.
> 6. Write `tests/integration-context-contract.test.ts` covering a full round-trip.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` (integration included) pass.
> - `node bin/ewh.mjs doctor` on a valid project returns a clean pass; on a contrived broken fixture (dangling rule ref) fails with a readable line.
> - `node bin/ewh.mjs start migrate` in a fixture project with old YAML converts files cleanly.
> - `grep -rn "workflows/[^e]" src/` (anything pointing at the old `.claude/workflows/` path) returns only the migrator.
> - `grep -n "create" CLAUDE.md README.md` shows only historical notes, no active recommendations.

---

## Notes for the Human Pilot

- **Branch per session.** Start each session on `main`, create branch `context-contract-session-N`, merge before the next. Resume points align with PR boundaries.
- **Spec is canonical.** If a session prompt and `specs/context-contract.md` disagree, the spec wins — update the prompt or the spec deliberately, not the implementation.
- **Fresh sessions have no memory.** Each prompt re-points at the spec and current-state files. Don't shortcut by pasting partial diffs between sessions.
- **Session 2 is the invasive one.** It modifies `prompt-builder.ts` and the workflow-loading entry. If it breaks existing workflows (plugin templates still running via YAML), investigate before layering Sessions 3+ on top.
- **Session 5 is the largest.** Budget 3+ hours; the ferry + diff + integrity check + rename-preservation logic compounds. If it runs long, consider splitting into 5a (ferry + diff) and 5b (integrity + rename preservation).
