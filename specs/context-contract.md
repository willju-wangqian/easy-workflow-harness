---
name: context-contract
type: decision
status: accepted
scope: [subcommands, context, workflows, agents, rules, schemas]
created: 2026-04-22
---

## Understanding Summary

- **What.** Redesign EWH's authoring surface so that every workflow is represented by a **two-file pair**: a human-facing `workflow.md` summary and a machine-authoritative `workflow.json` context contract. Introduce `/ewh:doit manage <workflow>` (fills runtime behaviors + context in JSON), refactor `/ewh:doit design <workflow>` (creates the pair via TUI interview), and add `/ewh:doit design modify <something>` (ferries edits to the outer-session LLM via a diffable proposed-slice protocol).
- **Why.** The current YAML-only model silently drops context: rule-injection keys on filename match against the workflow's `step.rules` list, while advisory frontmatter fields (`scope`, `inject_into`, `severity`, `verify`) are parsed and never consulted (`src/workflow/rule-loader.ts:29-46`). Project rules that aren't referenced by a workflow are invisible; unknown step fields are silently ignored (`src/workflow/parse.ts:132`). Typos, stale templates, and orphan rules don't fail anywhere.
- **Who.** End-users authoring project workflows, and plugin authors shipping starting-point templates.
- **Constraints.**
  - Binary drives; LLM executes. The state machine is a dispatcher during `design modify`, not a decision-maker.
  - Delivery of context must be fully deterministic and binary-owned. LLM obedience stays in the compliance layer (`severity: critical` + `verify:`).
  - No hand-edit escape hatch needed — both files are machine-owned.
  - Must coexist with existing runtime features: gates (structural/auto/compliance/error), chunked dispatch, script fallbacks, incremental agents.
- **Non-goals.**
  - Cross-session draft persistence for in-flight modifications.
  - Replacing the compliance/verify mechanism.
  - Enforcing any schema on plugin-shipped templates beyond what `design` already reads.

## Decision

### 1. Two-file workflow representation

Each project workflow is stored at `.claude/ewh-workflows/<name>.{md,json}`. Both are machine-owned; users edit through subcommands.

**`workflow.md`** — human-facing summary, derived from JSON. Per step: `name`, `agent`, `description`. Re-rendered from JSON after every `design modify` apply.

**`workflow.json`** — machine-authoritative contract. State machine reads **only** this file.

```jsonc
{
  "name": "add-feature",
  "description": "Plan, implement, review, and test a new feature.",
  "steps": [
    {
      "name": "plan",
      "agent": "planner",
      "description": "Design the feature.",
      "gate": "structural",
      "produces": [".ewh-artifacts/plan.md"],
      "context": [],
      "requires": [],
      "chunked": false,
      "script": null,
      "script_fallback": "gate"
    },
    {
      "name": "code",
      "agent": "coder",
      "description": "Implement the plan; run tests.",
      "gate": "structural",
      "produces": [".ewh-artifacts/code-output.md"],
      "context": [
        { "type": "rule",     "ref": "coding" },
        { "type": "artifact", "ref": ".ewh-artifacts/plan.md" }
      ],
      "requires": [{ "file_exists": ".ewh-artifacts/plan.md" }],
      "chunked": false,
      "script": null,
      "script_fallback": "gate"
    }
  ]
}
```

### 2. Context entries are typed

Every `context` entry is `{ "type": "rule" | "artifact" | "file", "ref": "<name-or-path>" }`.

- `type: "rule"` → `ref` is a rule name; resolved via `rules/` + `.claude/rules/` filename match; concatenated under `## Active Rules` in the assembled prompt.
- `type: "artifact"` → `ref` is a path; must be in some earlier step's `produces` (validated against the JSON); concatenated under `## Required Reading`.
- `type: "file"` → `ref` is a free path (escape hatch for arbitrary project files); `## Required Reading`.

### 3. Plugin assets become templates

`workflows/`, `agents/`, `rules/` under the plugin root are read by `design` as seed templates. They are never executed directly against a project. A project cannot run until it has its own `.claude/ewh-workflows/<name>.{md,json}`.

### 4. `/ewh:doit design <workflow>`

TUI-based interview. For each step: (a) name, (b) agent? which agent? (c) short description. Output:

1. `.claude/ewh-workflows/<name>.md` (rendered summary).
2. `.claude/ewh-workflows/<name>.json` (skeleton — all runtime fields at safe defaults, `context: []`, `produces: []`).
3. Stub `.claude/agents/<agent>.md` for any new agent the user named (minimal body derived from description).

If the user's description is close to a plugin template, facilitator offers the template as a starting point. Accepted template → same outputs, prefilled.

### 5. `/ewh:doit design modify <something>`

Ferry pattern. State machine is a dispatcher here, not a decision-maker.

1. Build a context package and emit `ACTION: outer-session-llm`. Package contains (decision Q10-C):
   - Full workflow JSON (all steps, compact).
   - Target asset's full `.md` body (agent or rule being modified).
   - First-order neighbors' **JSON-only** entries.
   - Catalog: names of all available rules + paths of all declared artifacts project-wide.
2. Outer-session LLM converses with the user and writes one or more **self-contained step slices** to `.ewh-artifacts/modify-<id>/proposed.json` as an array.
3. State machine resumes and runs a **structural diff** between proposed slices and current JSON (decision Q8-A, Q9-C):
   - Implicit set-difference on `name` handles update and add.
   - Explicit `"_delete": true` removes a step.
   - Explicit `"_rename_from": "<old>"` renames (preserves cross-step refs).
   - Optional top-level `"_order": [...]` reorders; absent = keep current order.
4. Referential-integrity check on every new `ref` in proposed slices: rule file exists; artifact produced by an earlier step; agent referenced by a step exists.
5. Gaps (diff + integrity failures) shipped back to the LLM with a *"warn about gaps and propose updates"* prompt. User approves or iterates.
6. On approval: state machine writes the merged JSON atomically, re-renders `workflow.md`, cleans up is deferred to the normal `.ewh-artifacts/` retention pass.

### 6. `/ewh:doit manage <workflow>`

TUI-based; replaces the working name `manage-context`. For each step, asks the user about runtime behavioral fields: `context`, `produces`, `gate`, `requires`, `chunked`, `script`, `script_fallback`. Updates JSON in place.

**Context catalog** offered to the user per step (decision Q6-B):
- Every `.md` under `rules/` + `.claude/rules/` (as `{type: rule}` picks).
- Every path declared as `produces` by steps 1..N-1 (as `{type: artifact}` picks).
- Free text entry for arbitrary `{type: file}` refs.
- Pre-selected: the target agent's `default_rules` frontmatter list (user can uncheck).

### 7. Agent frontmatter gains `default_rules`

```yaml
---
name: coder
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
default_rules: [coding]
---
```

Used by `manage` at **authoring time only** — pre-selects rule checkboxes. Runtime reads only JSON; no late-binding.

### 8. `ewh doctor` extensions

In addition to existing checks (#8/#9/#10 at `src/commands/doctor.ts:241-340`), walk every `.claude/ewh-workflows/*.json`:

- Every `context[].ref` resolves (rule filename match, or declared-by-earlier-step artifact, or real file path).
- Every `produces[]` path is under `.ewh-artifacts/`.
- Every `agent` in every step has a resolvable `.md`.
- For each step's `type: rule` refs, warn if they diverge from the agent's current `default_rules` (drift indicator — not an error).
- Warn if `workflow.md` and `workflow.json` disagree on `{name, agent}` per step (drift indicator).

## Alternatives Considered

- **Per-agent context keying** (Q4-C). Rejected: artifacts are positionally meaningful ("reviewer reads step N's output, not step M's"); outer-session/agentless steps have no agent key; DRY benefit for rules was addressed with authoring-time `default_rules` instead.
- **Late-bind agent defaults at runtime** (Q5-B). Rejected: destroys user intent (if they unchecked a default, late-binding re-adds it); reopens drift surface between agent frontmatter and runtime behavior.
- **Full JSON proposals for every modify** (Q8-B). Rejected: heavier LLM output, bigger diffs for tiny edits. Partial slices with `design modify` shipping current state keep LLM from dropping fields.
- **JSON Patch (RFC 6902)** (Q8-C). Rejected: LLMs emit unreliable pointer paths; debugging painful.
- **Implicit delete via set-difference** (Q9-A). Rejected: collapses rename into delete+add, silently destroying context refs that named the old step.
- **Persistent per-workflow drafts** (Q11-B). Rejected as YAGNI; adds stale-state surface; ephemeral-in-run-artifacts is reachable upgrade path.
- **Merge JSON into workflow.md as a machine-managed section** (Q7-C). Rejected after user's restated design: separate files are cleaner when both are machine-owned and one is regenerated from the other.
- **Keep `scope:` / `inject_into:` with real semantics.** Rejected: overlaps with typed `context` entries; doubles the routing surface without adding expressive power.

## Acceptance Criteria

1. Running `/ewh:doit design add-feature` in a fresh project produces `.claude/ewh-workflows/add-feature.{md,json}` and any new agent stubs under `.claude/agents/`.
2. Running `/ewh:doit manage add-feature` fills runtime fields and produces a JSON whose every `context[].ref` passes referential-integrity check.
3. Running `/ewh:doit design modify add-feature:code` in a populated project:
   - Ships full workflow JSON + target agent .md + neighbor JSON entries + rule/artifact catalog to the outer-session LLM.
   - Accepts an array of self-contained step slices written to `.ewh-artifacts/modify-<id>/proposed.json`.
   - Reports a structural diff + referential-integrity gaps to the user.
   - On approve: merges JSON atomically and re-renders `workflow.md`.
   - On rename: context refs to the old step name update correctly.
4. State machine ignores `.claude/workflows/*.md` (the old YAML location) and reads **only** `.claude/ewh-workflows/*.json`. A migration path exists for existing projects (one-time converter, or instruction to re-run `design`).
5. `ewh doctor` passes cleanly on a valid project and reports specific gaps on an invalid one (dangling ref, drift between `workflow.md` and JSON, `default_rules` divergence).
6. `severity: critical` + `verify:` rules continue to run post-step, unchanged.

## Decision Log

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| Q2 | Split responsibilities: workflow owns shape, JSON owns context. Plugin workflows are templates. | Additive override, UI-over-YAML, full replacement | Separates concerns; plugin ships starting points |
| Q3 | Move `rules:`, `reads:`, `context:` out of workflow YAML into JSON | Partial move, additive JSON, strip to step list | Single source of truth eliminates drift |
| Q4 | Per-step keying; agent `default_rules` is authoring-time suggestion | Per-agent, hybrid runtime merge | Artifacts are positional; simple implementation |
| Q5 | Typed `{type, ref}` context entries + doctor drift check | Late-bind defaults, flat strings | Enables section routing and referential integrity |
| — | Delivery is deterministic (binary); obedience is compliance-layer concern | "Failure at step 3" framing | Clean scope separation |
| Q6 | Catalog = rules + artifact placeholders + free files + agent defaults | No defaults, author whitelist | Ergonomic common case; deterministic artifact list |
| Q7 | Both files machine-owned (policy P1) | Free-form doc, reverse direction | Drift impossible by construction |
| Q8 | Partial self-contained slices | Full JSON, JSON Patch | LLM-ergonomic; diff-friendly |
| Q9 | Implicit for update/add; explicit for delete/rename; optional `_order` | Pure implicit, pure explicit | Destructive ops loud; common case light |
| Q10 | Full workflow JSON + target .md depth + neighbor JSON + names catalog | Minimal, local-only | JSON cheap to ship whole; catalog removes new-ref guessing |
| Q11 | Ephemeral in `.ewh-artifacts/modify-<id>/` | Persistent, hybrid | Matches existing run-artifact discipline |

## Open Questions / Deferred

- **Migration tool** from `.claude/workflows/<name>.md` (current) to `.claude/ewh-workflows/<name>.{md,json}` — scope via follow-up spec.
- **Cross-session draft persistence** — deferred until a user requests it.
- **`ewh doctor --fix`** for automatic resolution of trivial drift (e.g., re-rendering stale `workflow.md`) — out of scope here.
- **Plugin template format vs. project JSON format** — do templates ship as markdown-only, or also carry a JSON skeleton? Current decision: markdown-only; `design` derives the skeleton at interview time.
- **Interaction with `--trust` / `--yolo` flags.** Structural gates persist; manage/design flows are not subject to `--yolo`.
