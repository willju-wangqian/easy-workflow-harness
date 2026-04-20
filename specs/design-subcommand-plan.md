---
name: design-subcommand-plan
type: plan
status: active
scope: [subcommands, agents, ux]
created: 2026-04-20
tracks: design-subcommand
---

# Implementation Plan — `/ewh:doit design`

Companion to [design-subcommand](design-subcommand.md). Five sessions, each a cohesive PR. Earlier sessions ship vertical-slice partial functionality; later sessions build on top. Each session's **Fresh-Session Prompt** is self-contained — paste it into a new Claude Code session without prior context.

| # | Session | Scope | Roughly |
|---|---|---|---|
| 1 | Foundations | State types, agent definitions, catalog builder | 1–2 h |
| 2 | Interview + shape gate | Subcommand skeleton through shape-gate approval | 2–3 h |
| 3 | Authoring + per-file gates | Post-shape-gate flow: author, file_gate, refine | 2–3 h |
| 4 | Write phase | Scope validation, atomic writes, done summary | 1–2 h |
| 5 | Remove `create` + tests + docs | Deprecate old subcommand, integration coverage | 1–2 h |

---

## Session 1 — Foundations

### Deliverables

- New `SubcommandState` variants in `src/state/types.ts`:
  ```ts
  | { kind: 'design'; phase: 'interview'; description: string; catalog_path: string }
  | { kind: 'design'; phase: 'shape_gate'; proposal_path: string }
  | { kind: 'design'; phase: 'author'; proposal_path: string; author_index: number }
  | { kind: 'design'; phase: 'file_gate'; proposal_path: string; file_index: number }
  | { kind: 'design'; phase: 'refine'; proposal_path: string; file_index: number; instruction: string }
  | { kind: 'design'; phase: 'write'; proposal_path: string }
  ```
- Three new agent definition files in `agents/`:
  - `design-facilitator.md` — opus, `tools: [AskUserQuestion]`, `maxTurns: 30`, catalog-aware interview, emits `shape.json`, ends with `AGENT_COMPLETE`.
  - `artifact-author.md` — sonnet, `tools: [Read, Write]`, `maxTurns: 3`, writes one file body (plus unified diff if `op: update`), ends with `AGENT_COMPLETE`.
  - `artifact-refiner.md` — sonnet, `tools: [Read, Write]`, `maxTurns: 3`, applies natural-language edit to a staged file, ends with `AGENT_COMPLETE`.
- New helper `src/commands/design-catalog.ts` exporting `async function buildCatalog(projectRoot, pluginRoot): Promise<CatalogEntry[]>` — walks `workflows/`, `agents/`, `rules/` in both plugin and project `.claude/`, reads only frontmatter, returns `{ type, name, path, scope, description }` entries.
- Vitest coverage for `buildCatalog` against a small fixture project.

### Acceptance

- `npm run typecheck` passes with the new variants.
- `npm test` passes, including new catalog tests.
- `buildCatalog` returns entries from both plugin and project paths, deduped by (type, name) with project winning for workflows/agents and concatenating for rules per the existing resolution rules (§CLAUDE.md "Resolution order").
- Facilitator agent definition contains only `AskUserQuestion` in its `tools:` frontmatter (verified by reading the file).
- No wiring into `start.ts` / `report.ts` yet — this session is types and assets only.

### Fresh-Session Prompt

> I'm implementing a new `/ewh:doit design` subcommand for the Easy Workflow Harness plugin at `/Users/willju/development/easy-workflow-harness`. This is **Session 1 of 5: Foundations**.
>
> **Read first, in this order:**
> 1. `specs/design-subcommand.md` — the decision spec (full design)
> 2. `specs/design-subcommand-plan.md` — this plan (look at Session 1 acceptance criteria)
> 3. `CLAUDE.md` — EWH architecture overview
> 4. `src/state/types.ts` — `SubcommandState` discriminated union (around lines 200–255)
> 5. `agents/` — pick one existing agent (e.g. the simplest one) as a template for frontmatter + structure
> 6. `src/commands/cleanup.ts` — example of a subcommand's file organization (for where to place the catalog helper)
>
> **Scope of this session (do not do more):**
> 1. Add the six new `design` variants to `SubcommandState` in `src/state/types.ts`. Do not remove the existing `create` variants yet (Session 5).
> 2. Create `agents/design-facilitator.md`, `agents/artifact-author.md`, `agents/artifact-refiner.md`. Each must include: `## Before You Start` self-gate section, output format instructions, and end with the `AGENT_COMPLETE` sentinel. Facilitator tools = `AskUserQuestion` only. Every facilitator `AskUserQuestion` must include a standing "propose now" option alongside topical choices — state this explicitly in the agent prompt.
> 3. Implement `src/commands/design-catalog.ts` with `buildCatalog(projectRoot, pluginRoot)` as specified in the spec. Only read frontmatter (use a yaml parser already in the repo — check `package.json` dependencies).
> 4. Add vitest tests: create a fixture project with a few workflow/agent/rule files, assert `buildCatalog` returns the correct entries honoring resolution order.
>
> **Do not:**
> - Touch `src/commands/start.ts`, `src/commands/report.ts`, or `src/state/machine.ts`.
> - Remove `create` logic.
> - Create `src/commands/design.ts` yet.
>
> **Verify before reporting done:** `npm run typecheck` clean; `npm test` passes; three agent files exist and contain `AGENT_COMPLETE`; facilitator's `tools:` frontmatter is exactly `[AskUserQuestion]`.

---

## Session 2 — Interview + Shape Gate

### Deliverables

- New `src/commands/design.ts` with `startDesign(opts)` and `reportDesign(state, report)` functions matching the pattern in `src/commands/cleanup.ts`.
- Phases implemented: `interview` → `shape_gate`.
- `interview` phase emits a `tool-call` action invoking the `Task` tool with `subagent_type: design-facilitator`, passing the catalog (written to `.ewh-artifacts/<run>/catalog.json`) and the user's description. The facilitator writes `shape.json` to `.ewh-artifacts/<run>/proposed/shape.json`.
- On report of the facilitator's result file, transition to `shape_gate`.
- `shape_gate` phase:
  - Validates the proposal: all `op: update` paths must exist in the catalog; all `op: create` paths must NOT exist; all referenced `depends_on` entries must be in the same batch or the catalog.
  - Renders a human-readable summary (see spec § 3 for format).
  - Emits a `user-prompt` with three options: approve / reject / edit.
  - Validation failures re-enter `interview` with an error note appended (no user turn in between).
- Wire `design` into `src/commands/start.ts` dispatch.
- Wire `design` report handling into `src/commands/report.ts`.
- Unit tests for: successful interview → shape_gate transition; validation failure bounces back; shape_gate approval returns next phase (can assert it's `author` even though author isn't implemented yet — just confirm the state transition).

### Acceptance

- `/ewh:doit design "test description"` in manual smoke test reaches shape_gate (facilitator spawns, returns shape.json, gate renders).
- `npm test` passes; new tests cover the two phase transitions.
- If facilitator returns malformed `shape.json` (missing required fields), binary emits a readable error instead of crashing.

### Fresh-Session Prompt

> I'm continuing implementation of `/ewh:doit design` for the Easy Workflow Harness plugin at `/Users/willju/development/easy-workflow-harness`. This is **Session 2 of 5: Interview + Shape Gate**. Session 1 (types + agents + catalog builder) is complete on the current branch.
>
> **Read first:**
> 1. `specs/design-subcommand.md` — the decision spec, especially § 3 (proposal schema) and § "Implementation Notes"
> 2. `specs/design-subcommand-plan.md` — Session 2 acceptance criteria
> 3. `CLAUDE.md` — architecture overview
> 4. `src/commands/cleanup.ts` — pattern for `startX` / `reportX` subcommand functions
> 5. `src/commands/start.ts` and `src/commands/report.ts` — dispatch structure for subcommands
> 6. `src/state/types.ts` — look at the `design` variants added in Session 1
> 7. `agents/design-facilitator.md` — read the prompt contract you'll be fulfilling
>
> **Scope of this session:**
> 1. Create `src/commands/design.ts` with `startDesign` and `reportDesign`. Pattern-match on `src/commands/cleanup.ts`.
> 2. Implement the `interview` phase. It should:
>    - On start: write the catalog (from `buildCatalog`) to `.ewh-artifacts/<run>/catalog.json` and write the description to a file the facilitator prompt will reference.
>    - Emit a `tool-call` instruction invoking `Task` with `subagent_type: design-facilitator`. The prompt body passed to the agent must include paths to catalog + description + output (shape.json).
>    - On report of the facilitator's result file, read the shape.json, transition to `shape_gate`.
> 3. Implement the `shape_gate` phase:
>    - Validate: every `op: update` path exists in the catalog; every `op: create` path does NOT exist; `depends_on` entries are either in-batch or in-catalog.
>    - On validation failure: transition back to `interview` with an error note; the facilitator will re-run with added context.
>    - On success: render the human-readable summary (see spec § 3), emit `user-prompt` with approve/reject/edit options.
>    - On approve: transition to `author` phase (phase is defined but not yet implemented — that's Session 3; just return the transition).
>    - On reject: emit `done` with summary "Proposal rejected, no files written."
>    - On edit: transition back to `interview` with the user's edit note appended.
> 4. Wire into `src/commands/start.ts` — add `design` to the subcommand dispatch.
> 5. Wire into `src/commands/report.ts` — route `design` subcommand reports to `reportDesign`.
> 6. Unit tests: at least three cases — happy path to shape_gate, validation failure bounces back, approval returns next-phase transition.
>
> **Do not:**
> - Implement author, file_gate, refine, or write phases. Each should be a stub that emits a placeholder `done` with "next phase not implemented" if reached (so Session 2 can be tested end-to-end without crashing).
> - Remove `create`.
>
> **Verify before reporting done:** `npm run typecheck` clean; `npm test` passes; manual smoke `node bin/ewh.mjs start design -- "test description"` reaches the shape_gate action (can be simulated without the LLM by mocking the facilitator's shape.json in a test).

---

## Session 3 — Authoring + Per-File Gates + Refine

### Deliverables

- Phase `author` fully implemented:
  - Walks each artifact in the shape proposal; for each, emits a `tool-call` invoking `Task` with `subagent_type: artifact-author`.
  - Prompt passed to author: the shape entry for that artifact + path to the catalog + (for `op: update`) the existing file body.
  - Author writes to `.ewh-artifacts/<run>/proposed/<sanitized-path>.md` (plus `.diff` for updates).
  - On report, advance `author_index` and loop until all authored, then transition to `file_gate` with `file_index: 0`.
- Phase `file_gate`:
  - Reads the staged file (and diff if applicable).
  - Renders for the user: full body for creates, unified diff for updates.
  - Emits `user-prompt` with approve/reject/edit.
  - On approve: advance `file_index`; when last, transition to `write`.
  - On reject: emit `done` summary "Rejected file X, no files written." (no partial writes ever).
  - On edit: capture the user's instruction text (via follow-up `user-prompt` with free-form input), transition to `refine`.
- Phase `refine`:
  - Emits `tool-call` invoking `Task` with `subagent_type: artifact-refiner`, passing the staged file path + user's instruction.
  - On report, transition back to `file_gate` for the same `file_index` (which now reads the refined file).
- Unit tests for: author loop over multiple artifacts; file_gate approve-then-advance; file_gate reject; refine round trip.

### Acceptance

- `npm test` passes; new tests cover the four transitions.
- Manual smoke: full run from description → shape gate → author → per-file approvals → transitions to `write` phase.
- Rejecting any file aborts the run cleanly with no partial writes.

### Fresh-Session Prompt

> I'm continuing implementation of `/ewh:doit design` for the Easy Workflow Harness plugin at `/Users/willju/development/easy-workflow-harness`. This is **Session 3 of 5: Authoring + Per-File Gates + Refine**. Sessions 1–2 are complete on the current branch — types, agents, catalog, interview phase, shape_gate phase are all working.
>
> **Read first:**
> 1. `specs/design-subcommand.md` — the decision spec
> 2. `specs/design-subcommand-plan.md` — Session 3 acceptance criteria
> 3. `src/commands/design.ts` — existing phases (interview, shape_gate)
> 4. `agents/artifact-author.md` and `agents/artifact-refiner.md` — the prompt contracts
> 5. `src/state/types.ts` — design state variants
>
> **Scope of this session:**
> 1. Implement `author` phase in `src/commands/design.ts`:
>    - Track `author_index: number` in state (already in the variant).
>    - Emit one `tool-call` per authored artifact via `Task` with `subagent_type: artifact-author`.
>    - Prompt must include: shape entry (serialized), catalog path, and for `op: update`, path to the existing file (read by the agent, not inlined).
>    - Author writes staged file to `.ewh-artifacts/<run>/proposed/<safe-filename>.md`. For updates, author also writes a `.diff` file (unified diff vs. existing).
>    - On each author result reported, advance `author_index`. When past the last artifact, transition to `file_gate` with `file_index: 0`.
> 2. Implement `file_gate`:
>    - Read staged file (and `.diff` if update).
>    - Render: full body for create; unified diff for update. Emit `user-prompt` with approve/reject/edit.
>    - On approve: increment `file_index`; if all files approved, transition to `write` (stub for Session 4 — emit placeholder `done`).
>    - On reject: emit `done` immediately with summary "Rejected, no files written." No further processing.
>    - On edit: emit a second `user-prompt` asking for the free-form edit instruction. On that response, transition to `refine` with the instruction.
> 3. Implement `refine`:
>    - Emit `tool-call` via `Task` with `subagent_type: artifact-refiner`, passing staged file path + user instruction.
>    - Refiner overwrites the staged file (same path) and refreshes the `.diff` if applicable.
>    - On report, transition back to `file_gate` at the same `file_index`.
> 4. Unit tests for: multi-artifact author loop; file_gate approve-advance; file_gate reject aborts; refine round trip.
>
> **Do not:**
> - Implement the `write` phase yet (Session 4). Have it emit a placeholder `done` for now so the flow is testable end-to-end.
> - Touch the `create` subcommand.
>
> **Verify before reporting done:** `npm run typecheck`, `npm test`. Trace manually that a 3-artifact proposal goes through 3 author spawns, 3 file gates, and either transitions to `write` or aborts on any reject.

---

## Session 4 — Write Phase + Scope Validation

### Deliverables

- Plugin-repo detection: new helper `isInsidePluginRepo(projectRoot): boolean` that reads `package.json` and returns true iff `name === "easy-workflow-harness"`.
- Scope validation pass (run at start of `shape_gate` before display):
  - In non-plugin projects: any `scope: plugin` entry auto-rewritten to `scope: project`, with a one-line note prepended to the shape gate summary ("Cross-project plugin edits not supported; using .claude/ overrides for N artifacts.").
  - In plugin repo: `scope: project` means writing to the plugin's own `.claude/` test fixtures — prompt user to confirm once per run.
- Phase `write`:
  - Walk the staged proposal in dependency order: rules → agents → workflows.
  - For each artifact: resolve target path (`scope: plugin` → `<pluginRoot>/<path>`; `scope: project` → `<projectRoot>/.claude/<path>`). Atomic write via tmp → fsync → rename.
  - For `op: create`: fail if target exists (should never happen — guard against drift).
  - For `op: update`: target must exist; overwrite atomically.
  - Persist progress to state.json after each write so crash mid-write resumes at the next unwritten file.
  - On completion: emit `done` with a summary listing all written paths (`+` for create, `~` for update) and a suggestion for next steps.
- Unit tests: scope-rewrite in non-plugin project; dependency-order write; atomic-write crash-resume simulation; write-summary formatting.

### Acceptance

- `npm test` passes.
- Manual end-to-end smoke in a non-plugin project writes all files under `.claude/` and never touches plugin install.
- In the plugin repo, `scope: project` triggers the confirm prompt.
- Crash mid-write (kill the process after 1 of 3 writes) resumes and completes 2 and 3 without rewriting 1.

### Fresh-Session Prompt

> I'm continuing implementation of `/ewh:doit design` for the Easy Workflow Harness plugin at `/Users/willju/development/easy-workflow-harness`. This is **Session 4 of 5: Write Phase + Scope Validation**. Sessions 1–3 are complete — interview, shape_gate, author, file_gate, refine all work. Currently the `write` phase is a placeholder that emits `done`.
>
> **Read first:**
> 1. `specs/design-subcommand.md` — § "Write Phase" and § 4 of the design sections
> 2. `specs/design-subcommand-plan.md` — Session 4 acceptance criteria
> 3. `src/commands/design.ts` — existing phases
> 4. `src/state/store.ts` or wherever atomic state writes happen — reuse that pattern for artifact writes
>
> **Scope of this session:**
> 1. Helper `isInsidePluginRepo(projectRoot)`: read `<projectRoot>/package.json`, return `true` iff `.name === "easy-workflow-harness"`. Handle missing/unreadable package.json gracefully (return false).
> 2. Scope validation, invoked at start of `shape_gate` before rendering:
>    - If NOT inside plugin repo: rewrite all `scope: plugin` → `scope: project` in the proposal. Prepend a note to the rendered shape-gate summary: "Auto-rewrote N `scope: plugin` entries to `scope: project` (cross-project plugin edits not supported)." Mutate the staged shape.json on disk so downstream phases see the rewritten scope.
>    - If inside plugin repo AND any `scope: project` entries exist: emit an extra `user-prompt` before the normal shape gate, asking "These will write to the plugin's own `.claude/` — proceed? yes/no". Persist the decision in state so we don't re-ask on edit loops.
> 3. Implement the `write` phase:
>    - Walk artifacts sorted by dependency class: rules first, then agents, then workflows. Within each class, keep proposal order.
>    - Resolve target path: `scope: plugin` → `<pluginRoot>/<path>`; `scope: project` → `<projectRoot>/.claude/<path>`.
>    - For `op: create`: if target file exists, emit an error gate (this should never happen post-validation, so this is a drift guard).
>    - For `op: update`: target must exist; if missing, emit error gate.
>    - Write atomically using the same tmp→fsync→rename pattern used by the state machine (check `src/state/store.ts`).
>    - After each successful write, persist `state.subcommand_state` with a `written: string[]` field; on resume, skip already-written paths.
> 4. Emit final `done` with a summary block:
>    ```
>    Wrote N artifacts:
>      + .claude/workflows/foo.md
>      + .claude/agents/bar.md
>      ~ .claude/rules/baz.md  (updated)
>
>    Next: /ewh:doit <workflow-name> "<description>" to try it.
>    ```
> 5. Unit tests:
>    - Scope-rewrite in a non-plugin fixture project.
>    - Dependency-order: given a mixed proposal, assert write order.
>    - Crash-resume: simulate a crash after N writes, ensure resume completes the remainder.
>
> **Do not:**
> - Remove `create` (Session 5).
> - Add integration tests (Session 5).
>
> **Verify before reporting done:** `npm run typecheck`, `npm test`. Manual smoke writes real files into `.claude/` of a throwaway test project.

---

## Session 5 — Remove `create` + Integration Tests + Doctor Smoke + Docs

### Deliverables

- Remove `src/commands/create.ts`.
- Remove `{ kind: 'create'; ... }` variants from `src/state/types.ts`.
- `src/commands/start.ts`: when user invokes `/ewh:doit create [args]`, emit a `done` with:
  ```
  The `create` subcommand has been replaced by `design` — it now handles
  both creating and updating artifacts through a conversational interview.
  Run:   /ewh:doit design "<describe what you need>"
  ```
- `src/commands/list.ts`: replace `create` entry with `design`; update description.
- Integration test `tests/integration-design.test.ts`: full run from description → mocked facilitator → shape gate auto-approve → mocked author → file gate auto-approve → write. Verify final files land in expected paths.
- `src/commands/doctor.ts`: add a `--smoke` check that runs a scripted `design` session with a canned description and mocked agent outputs; verifies at least one file is written.
- Update `CLAUDE.md`:
  - Commands list: replace `/ewh:doit create …` examples with `/ewh:doit design …`.
  - Architecture paragraph: mention `design` in the subcommands list.
  - "Extending the Harness" section: note that `design` is the preferred way to create new agents/rules/workflows.
- Update `README.md` user-facing intro if it mentions `create`.

### Acceptance

- `npm run typecheck`, `npm test` (including new integration test) pass.
- `/ewh:doit list` shows `design` and no `create`.
- `/ewh:doit create anything` returns the deprecation message cleanly.
- `/ewh:doit doctor --smoke` passes.
- No lingering references to `create` subcommand in `CLAUDE.md` or `README.md` (other than historical notes).

### Fresh-Session Prompt

> I'm finishing implementation of `/ewh:doit design` for the Easy Workflow Harness plugin at `/Users/willju/development/easy-workflow-harness`. This is **Session 5 of 5: Remove `create` + Integration Tests + Doctor Smoke + Docs**. Sessions 1–4 are complete — `design` works end-to-end including writing files.
>
> **Read first:**
> 1. `specs/design-subcommand.md` — acceptance criteria
> 2. `specs/design-subcommand-plan.md` — Session 5 acceptance criteria
> 3. `src/commands/create.ts` — the code being removed
> 4. `src/commands/doctor.ts` — existing smoke checks pattern
> 5. `src/commands/list.ts` — how subcommands are listed
> 6. `CLAUDE.md` — search for `create` mentions to update
>
> **Scope of this session:**
> 1. Delete `src/commands/create.ts` entirely.
> 2. Remove every `{ kind: 'create'; ... }` variant from `src/state/types.ts`.
> 3. Update dispatch in `src/commands/start.ts`: when user invokes `create`, emit a `done` with a deprecation message pointing to `design` (exact text in Session 5 deliverables). Do not silently run `design` — make the user re-type.
> 4. Update `src/commands/list.ts` to show `design` in place of `create`.
> 5. Write `tests/integration-design.test.ts` covering a full happy-path run. Mock the three agents by writing their result files directly (same pattern used in existing integration tests).
> 6. Extend `src/commands/doctor.ts` `--smoke` mode: add a check that runs a scripted `design` session (canned description, mocked agents) and verifies at least one file lands in the expected staging path and then final location. Remove the staged/final files after the check.
> 7. Update `CLAUDE.md`:
>    - Replace `create` examples in the Commands section with `design` equivalents.
>    - Add `design` to the subcommands list in the Architecture paragraph.
>    - In "Extending the Harness", add a line: "Prefer `/ewh:doit design` over manual file creation — it interviews, proposes, and gates before writing."
> 8. Update `README.md` if it has user-facing examples using `create`.
>
> **Verify before reporting done:**
> - `npm run typecheck` clean; `npm test` passes (including new integration test); `npm run build` produces a working binary.
> - `node bin/ewh.mjs list` (or equivalent smoke) shows `design` and no `create`.
> - `node bin/ewh.mjs start create -- "anything"` returns the deprecation message and exits cleanly.
> - `node bin/ewh.mjs doctor --smoke` passes.
> - Grep `CLAUDE.md` and `README.md` for `create` — remaining matches should only be historical context or `git create`-unrelated.

---

## Notes for the Human Pilot

- **Branch per session.** Start each session on `main`, create a branch `design-subcommand-session-N`, and merge (or squash-merge) before starting the next. Resume points align with PR boundaries.
- **Spec is canonical.** If a session prompt and `specs/design-subcommand.md` disagree, the spec wins — update the prompt or the spec deliberately, not the fresh session's implementation.
- **Fresh sessions have no memory of prior ones.** Each prompt re-points at the spec and the current-state files. Don't shortcut by pasting partial diffs between sessions.
- **If Session N's fresh agent starts drifting** (spawning new abstractions, rewriting prior sessions' code), stop it and restart with a tighter prompt. The prompts above are tuned to prevent this but LLMs drift.
