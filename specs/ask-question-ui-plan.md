---
name: ask-question-ui-plan
type: plan
status: draft
scope: [subcommands, instructions, skill-shim, ux]
created: 2026-04-22
tracks: ask-question-ui
---

# Implementation Plan — AskUserQuestion UI for EWH

Companion to [ask-question-ui](ask-question-ui.md). Three sessions. Session 1 is the foundation (new instruction kind + emit + SKILL.md plumbing); sessions 2–3 convert subcommands and then workflow gates. Each session's Fresh-Session Prompt is self-contained.

| # | Session | Scope | Roughly |
|---|---|---|---|
| 1 | Foundation | New `ask-question` instruction kind, emit format, SKILL.md dispatch | 2–3 h |
| 2 | Subcommand conversions | `manage` + `design` binary gates → ask-question | 2–3 h |
| 3 | Workflow gate conversions + polish | Structural / compliance / error gates + docs + integration test | 2 h |

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

## Notes for the Human Pilot

- **Session 1 is the load-bearing one.** If its plumbing is wrong, Sessions 2 and 3 compound the bug. Budget extra time to lint the emission format (header lines, escaping, payload-path placement under `.ewh-artifacts/<run>/`).
- **`AskUserQuestion` caps** at 4 options. Every gate you convert must fit — if it can't, fall back to the file-based flow and note it in the spec's Open Questions.
- **Backward-compat test**: after each session, run the full `npm test`. Existing tests that assert on prose emission bodies for converted fields must be updated; don't `skip` them.
- **When to stop**: once gated decisions all render as pickers. Free-text and large-catalog prompts stay prose-based by design, not by bug.
