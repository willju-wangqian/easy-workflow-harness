---
name: ask-question-ui
type: decision
status: draft
scope: [subcommands, instructions, skill-shim, ux]
created: 2026-04-22
---

## Understanding Summary

- **What.** Replace the prose-based `user-prompt` gates in EWH subcommands and workflow gates with a structured `ask-question` instruction kind that the outer-session LLM renders via Claude Code's native `AskUserQuestion` tool. Users get an arrow-key-navigable picker (single- or multi-select, up to 4 options, optional per-option previews) instead of free-text replies interpreted by the LLM.
- **Why.** Today every decision point is prose: *"keep / clear / replace — reply in English and Claude will translate."* The outer LLM is an imperfect translator — it can misread ambiguous replies, and the UX diverges from Claude Code's built-in commands (`/plugin`, `/model`) that already use arrow-key pickers. `AskUserQuestion` is the same rendering engine the built-ins use; plugins just have to ask the outer session to invoke it.
- **Who.** End-users operating `/ewh:doit design`, `/ewh:doit manage`, `/ewh:doit design modify`, plus anyone driving a workflow through structural / compliance / error gates.
- **Constraints.**
  - Binary drives; LLM executes. EWH cannot call `AskUserQuestion` directly — only the outer Claude session can. The binary emits an instruction; the SKILL.md shim dispatches the tool.
  - `AskUserQuestion` caps at 4 options per question. Anything with more choices (rule catalog with N rules, artifact catalog with M paths) must fall back to the current "write JSON to a file" flow.
  - Free-text input (step descriptions, arbitrary paths, JSON replacements) is not what `AskUserQuestion` solves — keep the result-file pattern for those.
  - Backward-compatible: existing prose-based `user-prompt` gates must keep working while conversions happen incrementally.
- **Non-goals.**
  - Replace the file-based input path for multi-line text / JSON editing.
  - Move the entire subcommand surface to structured prompts in one session — conversion is per-field, per-gate.
  - Rework `AskUserQuestion` itself or the Claude Code TUI.

## Decision

### 1. New instruction kind: `ask-question`

Extend `InstructionKind` in `src/state/types.ts` with `ask-question`. The emitted `Instruction` carries a `question_payload` mirroring `AskUserQuestion`'s schema:

```ts
type AskQuestionPayload = {
  questions: Array<{
    question: string;
    header: string;              // ≤ 12 chars, chip label
    options: Array<{
      label: string;             // 1-5 words, the selectable text
      description: string;       // context / implications
      preview?: string;          // optional markdown preview
    }>;
    multiSelect: boolean;
  }>;
  /** Scratch path the shim writes the picked label(s) to. */
  result_path: string;
};
```

Single question per turn keeps the state machine simple. If a step needs multiple questions in sequence, emit one per `ewh report` round-trip. (`AskUserQuestion` supports 1-4 questions in one tool call; we defer that until a use case appears.)

### 2. Emit format

`src/instruction/emit.ts` renders the new kind as:

```
ACTION: ask-question
<one-line human summary>
PAYLOAD_PATH: .ewh-artifacts/<run>/ask-<step>-<field>.json
REPORT_WITH: ewh report --run <id> --step <i> --result <result_path>
```

The binary writes the full JSON payload to `PAYLOAD_PATH` (avoids shoving structured data through stdout). The shim reads it, calls `AskUserQuestion`, writes the picked label(s) to `result_path`, then runs the `REPORT_WITH` command.

### 3. SKILL.md protocol extension

`skills/doit/SKILL.md` gains a dispatch rule:

> When `ACTION: ask-question`:
> 1. Read the JSON at `PAYLOAD_PATH`.
> 2. Call `AskUserQuestion` with `{questions: <payload.questions>}`.
> 3. Write the picked label(s) to `<result_path>` as JSON:
>    - single-select: `"<label>"`
>    - multi-select: `["<label1>", "<label2>", ...]`
> 4. Run the `REPORT_WITH` command verbatim.

### 4. Report parsing

`src/commands/report.ts` + subcommand `continueX` handlers treat the result file as structured JSON when the prior emission was `ask-question`. For compatibility, subcommands track the expected result shape per field via existing `SubcommandState`.

### 5. Conversion priorities

High-value conversions (fit the 4-option cap, clearly decision-shaped):

| Surface | Today | With `ask-question` |
|---|---|---|
| `manage` gate flip | prose with `yes/no` | 2 options: `structural` / `auto` |
| `manage` chunked flip | prose with `yes/no` | 2 options: `true` / `false` |
| `manage` script_fallback flip | prose with `yes/no` | 2 options: `gate` / `auto` |
| `design` shape gate | prose with `yes/no` | 2 options: `accept` / `revise` |
| `design` file gate | prose with `yes/no` | 3 options: `accept` / `refine` / `skip` |
| workflow structural gate | prose with `yes/no` | 2 options: `proceed` / `abort` |
| workflow compliance gate | prose | 3 options: `retry` / `skip` / `abort` |
| workflow error-retry gate | prose | 3 options: `retry` / `abort` / `skip` |

Multi-select fits when the catalog is small (≤4 items). For `manage`'s rule picker (potentially 10+ rules), keep the JSON-file flow; upgrade later to a paginated picker if the UX complaint recurs.

### 6. Back-compat

- `ask-question` is additive. Prose `user-prompt` emissions keep working.
- Conversions land per-subcommand, per-field. A mixed run (some fields ask-question, others prose) is valid.
- Tests keep working because each subcommand's result handler already accepts either `decision` or `result` reports — the conversion only changes which one is emitted.

## Alternatives Considered

- **Enrich `user-prompt` with an optional payload instead of adding a new kind.** Rejected: requires every SKILL.md dispatch to branch on "is this a structured prompt or prose?" for every turn, even non-structured ones. A distinct `ACTION:` header is easier to route.
- **Spawn a long-running TUI process.** Rejected: fights Claude Code's one-shot-per-turn tool model, destroys crash-resume, and duplicates `AskUserQuestion`.
- **Inline the payload in the stdout body.** Rejected: JSON inside `ACTION: user-prompt` bodies is fragile (newlines in option descriptions, escaping). Payload-via-file mirrors how agent prompts and result files already flow.
- **Force every choice through `AskUserQuestion`, even multi-line text.** Rejected: `AskUserQuestion` is for *selection*, not free-form editing. The file-based flow is the right tool for JSON replacements and prose.
- **Use MCP `elicit-input` instead.** Rejected: adds an MCP server surface just for UI, and the MCP elicit-input protocol is newer/less stable than `AskUserQuestion`. Revisit if MCP offers a better primitive later.

## Acceptance Criteria

1. `src/state/types.ts` carries an `ask-question` instruction kind with typed payload.
2. `src/instruction/emit.ts` serializes `ask-question` to the documented three-line header, with payload written to `PAYLOAD_PATH`.
3. `skills/doit/SKILL.md` has an `ACTION: ask-question` branch that invokes `AskUserQuestion` and reports back.
4. At least one manage field (e.g., `gate` flip) and one design gate (e.g., shape gate) are converted to `ask-question`; existing tests pass with the new emission path.
5. Non-converted surfaces continue to emit prose `user-prompt` and continue to work.
6. Manual smoke: running `/ewh:doit manage <workflow>` in a fresh project walks the user through at least one arrow-key picker.

## Decision Log

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| Q1 | New instruction kind `ask-question` | Enrich `user-prompt` | Distinct ACTION header routes cleanly in SKILL.md |
| Q2 | Payload-via-file (`PAYLOAD_PATH`) | Inline JSON in body | Large/nested payloads don't belong in stdout |
| Q3 | One question per turn (for now) | Batch up to 4 in one tool call | State machine stays simple; lift later if needed |
| Q4 | Keep file-based flow for free-text + large catalogs | Force everything through `AskUserQuestion` | Tool is for selection, not editing; 4-option cap binds |
| Q5 | Incremental per-field conversion | Big-bang rewrite | Ships value early; keeps existing tests green |

## Open Questions / Deferred

- **Paginated multi-select** for rule / artifact catalogs that exceed 4 options. First cut ships with the file-based flow for these; revisit after the high-value binary gates are converted.
- **Preview panels** for option comparisons (e.g., show the current vs. proposed script when offering `retry` vs `edit` on a script fail). Supported by `AskUserQuestion` but out of scope for v1.
- **Multi-question bundles** (1 tool call, 1-4 questions). Deferrable until a UX pain point — e.g. the `manage` walk could collapse adjacent binary flips into one prompt.
- **Workflow gate conversions.** The spec lists structural/compliance/error gates in the priority table; the plan may start with subcommands and add workflow gates in a later session if the payload plumbing proves clean.
