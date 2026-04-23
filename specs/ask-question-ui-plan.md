---
name: ask-question-ui-plan
type: plan
status: draft
scope: [subcommands, instructions, skill-shim, ux]
created: 2026-04-22
tracks: ask-question-ui
---

# Implementation Plan — AskUserQuestion UI for EWH

Companion to [ask-question-ui](ask-question-ui.md). Four sessions. Session 1 is the foundation (new instruction kind + emit + SKILL.md plumbing); sessions 2–3 convert existing subcommand and workflow gates; session 4 uses the new primitive to collapse the duplicated LLM-driven design facilitators into a single binary-driven interview. Each session's Fresh-Session Prompt is self-contained.

| # | Session | Scope | Roughly |
|---|---|---|---|
| 1 | Foundation | New `ask-question` instruction kind, emit format, SKILL.md dispatch | 2–3 h |
| 2 | Subcommand conversions | `manage` + `design` binary gates → ask-question | 2–3 h |
| 3 | Workflow gate conversions + polish | Structural / compliance / error gates + docs + integration test | 2 h |
| 4 | Binary-driven design interview | Replace both design facilitators with a state-machine interview; fixes the `design "prose"` legacy-output bug | 3–4 h |

---

## Session 1 — Foundation

### Deliverables

- Extend `InstructionKind` in `src/state/types.ts` with `'ask-question'`; extend `Instruction` with an optional `question_payload: AskQuestionPayload` and an optional `payload_path: string` (where the binary wrote the JSON for the shim to read).
- Export the `AskQuestionPayload` type mirroring AskUserQuestion's schema (`questions[]` with `{question, header, options[], multiSelect}` + a `result_path`).
- New module `src/instruction/ask-question.ts` (or inline in `emit.ts`):
  - `emitAskQuestion(instruction, runDir): string` — writes the payload to `<runDir>/ask-<id>.json`, returns the three-line stdout header.
  - `parseAskQuestionResult(path): string | string[]` — reads and validates the shim's reply (single label or array).
- `src/instruction/emit.ts`: route `kind: 'ask-question'` through the new helper; prose `user-prompt` path unchanged.
- `skills/doit/SKILL.md`: add an `ACTION: ask-question` branch per spec §3. Include a worked example: read `PAYLOAD_PATH`, call `AskUserQuestion`, write picked label(s) to `<result_path>`, run `REPORT_WITH`.
- Vitest coverage:
  - Round-trip: emit a payload → read it back → simulate shim writing a label → parse successfully.
  - Bad inputs: missing payload file, malformed JSON, label not in options list → readable error.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- No subcommand yet uses `ask-question`; nothing breaks.
- Manual smoke: a hand-crafted unit test that emits an `ask-question`, runs the shim's simulated flow, and confirms the resulting `Report` carries the right label.

### Fresh-Session Prompt

> I'm adding `AskUserQuestion`-powered UI to Easy Workflow Harness at `/Users/willju/development/easy-workflow-harness`. This is **Session 1 of 3: Foundation**. No subcommand conversions yet — pure plumbing.
>
> **Read first:**
> 1. `specs/ask-question-ui.md` — the decision (§1 payload shape, §2 emit format, §3 SKILL.md protocol).
> 2. `specs/ask-question-ui-plan.md` — Session 1 deliverables + acceptance.
> 3. `src/state/types.ts` — `Instruction`, `InstructionKind`.
> 4. `src/instruction/emit.ts` — existing emission format.
> 5. `skills/doit/SKILL.md` — shim structure and ACTION dispatch table.
> 6. `src/commands/report.ts` — how result files land back in the state machine.
>
> **Scope (do not exceed):**
> 1. Extend `InstructionKind` with `'ask-question'`. Add `question_payload` + `payload_path` optional fields on `Instruction`. Export `AskQuestionPayload` from `src/state/types.ts` (or a new sibling file) per spec §1.
> 2. In `src/instruction/emit.ts`, route `kind: 'ask-question'` to a new helper that writes the payload JSON to `<runDir>/ask-<step>-<field>.json` and emits the three-line header per spec §2. Preserve all existing emission paths.
> 3. Add the `ACTION: ask-question` branch in `skills/doit/SKILL.md`. Keep the prose path and all other branches unchanged.
> 4. Unit tests (new file `tests/ask-question-emit.test.ts`):
>    - Emits an instruction with one multi-select question → payload JSON written, stdout header matches.
>    - Parses a picked label back from the result file → returns the string / array.
>    - Malformed result file → readable error.
>
> **Do not:**
> - Convert any subcommand emission to ask-question (Session 2).
> - Touch workflow gates (Session 3).
> - Add more than one question per payload — batching is deferred.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - `grep -rn "ask-question" src/` shows it in `types.ts`, `emit.ts`, tests, and SKILL.md — nowhere else yet.
> - Commit message: `feat(ask-question): session 1 — instruction kind + emit + SKILL.md dispatch`.

---

## Session 2 — Subcommand Conversions

### Deliverables

- Convert the binary-decision fields in `src/commands/manage.ts`:
  - `gate` flip (2 options: `structural`, `auto`).
  - `chunked` flip (2 options: `true`, `false`).
  - `script_fallback` flip (2 options: `gate`, `auto`).
  - Each emits an `ask-question` instead of a prose `user-prompt`. Result parsing updated to map the picked label back to the field value.
- Convert `src/commands/design.ts` gates:
  - Shape gate (2 options: `accept`, `revise`).
  - File gate (3 options: `accept`, `refine`, `skip`).
- Keep `context` (multi-select from a rules / artifacts catalog that may exceed 4) on the file-based flow. Out of scope for this session.
- Update existing tests: `manage.test.ts`, `design.test.ts`, `integration-design.test.ts`, `integration.test.ts` where they assert emission shape. Tests should cover both "shim picked `structural`" and "shim picked `auto`" paths via the new result-file protocol.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- Manual: running `/ewh:doit manage <wf>` in a scratch project shows an arrow-key picker for `gate` / `chunked` / `script_fallback` fields; context / produces / requires / script still use the file-based flow.
- Manual: `/ewh:doit design "a rule about X"` surfaces arrow-key gates at shape and file approvals.
- No regression in `start-contract` / `integration` tests.

### Fresh-Session Prompt

> I'm continuing the AskUserQuestion UI work for EWH at `/Users/willju/development/easy-workflow-harness`. This is **Session 2 of 3: Subcommand Conversions**. Session 1 complete — `ask-question` instruction kind, emit format, and SKILL.md dispatch all work.
>
> **Read first:**
> 1. `specs/ask-question-ui.md` — § 5 (conversion priorities table) and § 6 (back-compat).
> 2. `specs/ask-question-ui-plan.md` — Session 2 acceptance.
> 3. Current `src/commands/manage.ts` — per-field prompt renderers.
> 4. Current `src/commands/design.ts` — shape gate + file gate renderers.
> 5. `src/instruction/emit.ts` and the `ask-question` helper from Session 1.
> 6. `tests/manage.test.ts` + `tests/design.test.ts` — assertions you'll update.
>
> **Scope (do not exceed):**
> 1. In `manage.ts`, convert `gate` / `chunked` / `script_fallback` field renderers from prose `user-prompt` to `ask-question` with the options in the spec's § 5 table. Update the matching `applyXReport` handlers to read the label from the result file and map to the field value.
> 2. In `design.ts`, convert the shape gate (accept/revise) and file gate (accept/refine/skip) to `ask-question`. Keep every other phase on its current emission path.
> 3. Leave `context` (rule picker) and any other field with >4 options on the file-based flow. Note in a comment that pagination is deferred to the spec's Open Questions.
> 4. Update / extend tests:
>    - Adjust any test that asserts on the `user-prompt` body shape for the converted fields.
>    - Add `ask-question`-specific tests for the new emission (payload content correct, chosen label round-trips).
>    - Integration tests (`integration-design.test.ts`) simulate the shim by writing a label to the result file.
>
> **Do not:**
> - Convert workflow-level gates (structural / compliance / error). That's Session 3.
> - Convert `context` or `produces` or other multi-select / free-text fields.
> - Change the `ask-question` plumbing from Session 1.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - `grep -n "ask-question" src/commands/manage.ts src/commands/design.ts` shows the conversions landed only in the intended fields.
> - Commit message: `feat(ask-question): session 2 — manage + design gates use AskUserQuestion`.

---

## Session 3 — Workflow Gate Conversions + Polish

### Deliverables

- Convert workflow-level gates in `src/state/machine.ts` (or wherever `enterPending` / gate emissions live):
  - Structural gate (`proceed` / `abort`).
  - Compliance gate (`retry` / `skip` / `abort`).
  - Error-retry gate on exhaustion (`retry` / `abort` / `skip-remaining`).
- Update `src/commands/resume.ts` drift gate to use `ask-question` (`confirm` / `abort`).
- Update `skills/doit/SKILL.md` with a worked example block for each gate shape so the outer LLM has a mental model.
- Integration test `tests/integration-ask-question.test.ts`:
  - `manage` flow completes via ask-question round-trips.
  - Structural gate on a workflow emits ask-question; picking `abort` halts the run.
  - Compliance failure emits ask-question; picking `skip` completes the step as skipped.
- Docs:
  - `CLAUDE.md` — add a short line under **Key Contracts** noting `ask-question` is the preferred emission for gated decisions; prose `user-prompt` remains valid for free-text / large catalogs.
  - `README.md` — a one-sentence note in the *How It Works* section that gate prompts render via AskUserQuestion.

### Acceptance

- `npm run typecheck`, `npm test` (including new integration test) pass.
- Manual: run a workflow with a structural gate — the gate appears as an arrow-key picker.
- Manual: run a workflow that triggers a compliance failure — the picker offers retry/skip/abort.
- `grep -rn "ACTION: user-prompt" src/` narrows to only the free-text / large-catalog emission sites; every gated decision uses `ACTION: ask-question`.

### Fresh-Session Prompt

> I'm finishing the AskUserQuestion UI for EWH at `/Users/willju/development/easy-workflow-harness`. This is **Session 3 of 3: Workflow Gates + Polish**. Sessions 1–2 complete — foundation in place; `manage` and `design` binary gates already use `ask-question`.
>
> **Read first:**
> 1. `specs/ask-question-ui.md` — § 5 conversion priorities; § 6 back-compat.
> 2. `specs/ask-question-ui-plan.md` — Session 3 acceptance.
> 3. `src/state/machine.ts` — gate emission points (`enterPending`, compliance failure, error-retry gate).
> 4. `src/commands/resume.ts` — drift gate.
> 5. `skills/doit/SKILL.md` — current ask-question branch.
> 6. `CLAUDE.md` + `README.md` — doc update targets.
>
> **Scope:**
> 1. Convert the three workflow gates (structural, compliance, error-retry) to `ask-question` emissions. Map picked labels to the existing decision semantics (`proceed` ≡ `--decision yes`, `abort` ≡ `--decision no` / `--abort`, `skip` ≡ existing skip handler, `retry` ≡ existing retry handler). Keep the report-handler logic unchanged where possible — only the emission shape changes.
> 2. Convert the resume drift gate to `ask-question` (`confirm` / `abort`).
> 3. Update SKILL.md: add a worked example block for each gate shape (structural vs. compliance vs. error) so the outer LLM recognizes them reliably.
> 4. Write `tests/integration-ask-question.test.ts` covering: manage round-trip via ask-question, structural-gate abort, compliance-failure skip.
> 5. Update `CLAUDE.md` and `README.md` per deliverables.
>
> **Do not:**
> - Paginate the rule catalog or otherwise touch multi-select fields (still deferred).
> - Batch multiple questions into one tool call — one question per turn stays the contract.
> - Remove the prose `user-prompt` emission path — it's still used for free-text and large catalogs.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass.
> - `grep -rn "ACTION: user-prompt" src/` — remaining hits are only emission sites you consciously left on the file-based flow (document each in a one-line code comment).
> - Manual smoke: `/ewh:doit <workflow-with-structural-gate>` shows an arrow-key picker at the gate.
> - Commit message: `feat(ask-question): session 3 — workflow gates use AskUserQuestion + docs`.

---

## Session 4 — Binary-Driven Design Interview

### Motivation

Today `/ewh:doit design` dispatches one of two LLM subagent prompts to run the requirements interview:

- **Generic facilitator** (`agents/design-facilitator.md`): emits a flat `ShapeProposal` describing rules / agents / workflows.
- **Workflow facilitator** (same agent, alternate prompt wired in `buildWorkflowFacilitatorInstruction`): emits a `WorkflowDraft` with ordered `steps[]`.

`startDesign` picks between them using `isWorkflowName()` — a regex that only matches a bare kebab identifier. Any prose description (e.g. `"a quick smoke workflow with two steps"`) falls through to the generic path, which still emits the **legacy** workflow schema (`frontmatter: {name, description, trigger}`, `path: workflows/<name>.md`) and silently writes `.claude/workflows/<name>.md` — bypassing the Context Contract entirely. Five places cooperate in the bug: routing, facilitator prompt, shape validation, writer, and the catalog generator (which scans legacy `workflows/` instead of `.claude/ewh-workflows/`).

The root cause is architectural: **two LLM-driven interviews with different output schemas, gated by a fragile routing heuristic.** The `ask-question` primitive from Session 1 lets the binary drive the interview directly, which collapses both facilitators into one state machine and makes the buggy code path literally deletable.

### Deliverables

- **New binary-driven design state machine** in `src/commands/design.ts`:
  - `design_pick_type` — `ask-question`: `rule` / `agent` / `workflow` (3 options, fits the 4-cap).
  - `design_pick_op` — `ask-question`: `create` / `update <existing>` (catalog-filtered by chosen type; fall back to file-flow when the catalog has >3 candidates, keeping the 4-cap for the `create` option).
  - `design_name` — file-based free-text for the identifier (reuse existing `user-prompt` + result-file flow).
  - `design_description` — file-based free-text for the one-line description.
  - Type-specific branches:
    - `rule`: ask `severity` (2 opts: `warning` / `critical`); ask `inject_into` via the existing file-flow (multi-select exceeds 4); author-agent writes body.
    - `agent`: ask `model` (3 opts: `haiku` / `sonnet` / `opus`); collect `tools` via file-flow; author-agent writes body.
    - `workflow`: loop — per step collect `name` + `agent` + `description` via file-flow, then `ask-question` `add another step?` (`yes` / `no` / `done-propose`). On `done-propose`, synthesize a `WorkflowDraft` and route through the existing `continueWorkflowWrite` writer (already produces the `.json` + `.md` pair correctly).
  - Final shape gate uses the ask-question converted in Session 2.
- **Delete dead code:**
  - `isWorkflowName` function + its call site.
  - `buildWorkflowFacilitatorInstruction` + the `design_workflow_*` phases in `SubcommandState` (`design_workflow_interview`, `design_workflow_template_gate`, `design_workflow_gate`, `design_workflow_write`), plus their `continueWorkflow*` handlers — the new state machine replaces them. Keep `draftToContract`, `renderAgentStub`, and `continueWorkflowWrite`'s atomic write block (refactor the write block into a helper the new state machine calls).
  - The `type: "workflow"` branch of `agents/design-facilitator.md` (schema comment, path guidance). Keep the agent for rule / agent body authorship only — rename description to reflect the narrower role.
- **Hard-guard** `validateShape`: reject any `type: "workflow"` artifact with a diagnostic saying the design interview is now binary-driven and pointing to `/ewh:doit design` with no special args. (Defense in depth for any stale shape files from a previous run.)
- **Catalog fix** `src/commands/design-catalog.ts`: scan `.claude/ewh-workflows/*.json` (contracts) instead of `.claude/workflows/*.md` (legacy). One `collectEntries` call path swap; the parse adapter already understands the JSON shape via `loadContract`.
- **Tests** — new `tests/integration-design-v2.test.ts`:
  - Full `design` run picking `workflow` writes `.claude/ewh-workflows/<name>.{json,md}` and leaves `.claude/workflows/` absent.
  - Full `design` run picking `rule` / `agent` produces the expected project file and no workflow artifacts.
  - Regression: prose description `"a quick smoke workflow"` no longer triggers any legacy-path emission (grep the run transcript for `workflows/` as a negative assertion).
  - `validateShape` hard-guard: synthetic shape with `type: workflow` → explicit error.
  - Catalog: fixture project with one contract pair → `buildCatalog` surfaces it under `.claude/ewh-workflows/<name>.json`.

### Acceptance

- `npm run typecheck`, `npm test` pass.
- `grep -rn "isWorkflowName\|design_workflow_interview\|buildWorkflowFacilitatorInstruction" src/` returns no matches.
- `grep -rn "\\.claude/workflows/" src/` is limited to `migrate.ts` and `list.ts`'s legacy-count banner — nowhere in the design path.
- Manual: `/ewh:doit design` (no args) opens with the type picker. Same invocation with prose, with a kebab name, with `modify <target>` — all land on the correct branch; no path produces `.claude/workflows/*`.
- Manual: the Session 2 shape-gate ask-question still renders identically (no regression from the upstream churn).

### Fresh-Session Prompt

> I'm finishing the AskUserQuestion UI work for EWH at `/Users/willju/development/easy-workflow-harness`. This is **Session 4 of 4: Binary-Driven Design Interview**. Sessions 1–3 complete — the `ask-question` instruction kind is live, `manage` / `design` binary gates use it, workflow gates use it, docs updated.
>
> This session collapses the two LLM-driven design facilitators into a single binary-owned state machine, using the `ask-question` primitive. A known bug (`/ewh:doit design "<prose>"` silently emits legacy `.claude/workflows/<name>.md`) falls out when the buggy path is deleted.
>
> **Read first:**
> 1. `specs/ask-question-ui.md` — §1 instruction kind, §4 report parsing.
> 2. `specs/ask-question-ui-plan.md` — Session 4 deliverables + acceptance.
> 3. `src/commands/design.ts` — `startDesign`, `isWorkflowName`, the full `SubcommandState { kind: 'design' }` phase set, `continueWorkflowWrite`, `draftToContract`, `validateShape`.
> 4. `src/commands/design-catalog.ts` — current workflow scan (legacy paths).
> 5. `agents/design-facilitator.md` — current dual-mode prompt.
> 6. `src/workflow/contract-loader.ts` + `src/workflow/render-md.ts` — the contract pair writers (reuse verbatim).
> 7. `CLAUDE.md` — *Architecture* section on the contract pair and `design`-subcommand contract.
>
> **Scope (do not exceed):**
> 1. Add the new state-machine phases per deliverables. Each phase emits exactly one instruction per turn; free-text inputs keep the existing file-flow; binary choices use `ask-question`.
> 2. For `workflow`, the step-collection loop calls `continueWorkflowWrite` (or a refactored sibling) on `done-propose`, which already produces the `.json` + `.md` pair. Agent stubs keep their current behavior.
> 3. Delete `isWorkflowName`, `buildWorkflowFacilitatorInstruction`, the `design_workflow_*` phases, and their handlers.
> 4. Narrow `agents/design-facilitator.md` to rule / agent body authorship only. Drop `type: workflow` from its shape schema.
> 5. Add the `validateShape` hard-guard (even though live code no longer produces `type: workflow`, belt-and-braces against stale proposals).
> 6. Fix `design-catalog.ts` to scan `.claude/ewh-workflows/*.json`.
> 7. Write `tests/integration-design-v2.test.ts` per deliverables. Update any existing test that referenced the deleted phases or the legacy schema.
>
> **Do not:**
> - Change the `ask-question` plumbing from Session 1 or the converted gates from Sessions 2–3.
> - Move free-text collection (step descriptions, tool lists) into `ask-question` — 4-option cap still binds; file-flow stays.
> - Keep legacy paths around "for migration." `migrate` already exists and is the only supported path from the old layout.
>
> **Verify before reporting done:**
> - `npm run typecheck`, `npm test` pass including the new integration test.
> - `grep -rn "isWorkflowName\|design_workflow_interview\|buildWorkflowFacilitatorInstruction" src/` returns zero matches.
> - `grep -rn "\\.claude/workflows/" src/` appears only in `migrate.ts` and `list.ts`'s legacy-count banner.
> - Manual smoke: `/ewh:doit design` (no args), `/ewh:doit design "prose"`, `/ewh:doit design smoke` all land on the same type picker and never write under `.claude/workflows/`.
> - Commit message: `feat(ask-question): session 4 — binary-driven design interview, remove facilitator duplication`.

---

## Notes for the Human Pilot

- **Session 1 is the load-bearing one.** If its plumbing is wrong, Sessions 2 and 3 compound the bug. Budget extra time to lint the emission format (header lines, escaping, payload-path placement under `.ewh-artifacts/<run>/`).
- **`AskUserQuestion` caps** at 4 options. Every gate you convert must fit — if it can't, fall back to the file-based flow and note it in the spec's Open Questions.
- **Backward-compat test**: after each session, run the full `npm test`. Existing tests that assert on prose emission bodies for converted fields must be updated; don't `skip` them.
- **When to stop**: once gated decisions all render as pickers and the design interview runs from the binary. Free-text and large-catalog prompts stay file-based by design, not by bug.
- **Session 4 is the bug-fix session.** The silent-legacy-output bug (`design "<prose>"` → `.claude/workflows/*.md`) is not fixed until Session 4 lands. If you need the fix sooner, land a standalone hotfix (hard-guard `validateShape` + catalog path swap) and still complete Session 4 afterward — the hotfix becomes vestigial and gets removed alongside the facilitator deletion.
