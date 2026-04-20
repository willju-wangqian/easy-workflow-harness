---
name: design-subcommand
type: reference
scope: [subcommands, agents, ux]
created: 2026-04-20
---

## Understanding Summary

- **What:** A new `/ewh:doit design` subcommand that replaces the existing `create` subcommand. Offers a conversational interview to propose one or more EWH artifacts (workflows, agents, rules — in any combination, new or updates), then shape-gate + per-file approval before writing files.
- **Why:** The v2 `create` subcommand required users to manually invoke `create agent` / `create rule` / `create workflow` for each artifact. In practice users forget, then directly edit agent/rule/workflow files, violating the binary-driven design (no drift detection, no state machine protection, no catalog indexing).
- **Who:** EWH users authoring or revising EWH artifacts — both those with a detailed spec upfront and those who want to discuss before deciding.
- **Constraints:**
  - Keep the binary backbone: deterministic state machine, resumable gates from shape-gate onward, drift detection machinery unchanged.
  - Interview must feel like a conversation, not a form.
  - Facilitator must not be able to read project source code (unbounded context risk).
  - Cross-project plugin edits must be rejected.
- **Non-goals:**
  - Not ambient (no watching arbitrary conversations).
  - Not replacing `init`, `cleanup`, `doctor`, `list`, `expand-tools`.
  - Not touching non-EWH files.
  - No undo mechanism (relies on git).

## Decision

Ship `/ewh:doit design` as a subcommand in `src/commands/design.ts`, using the lightweight `SubcommandState` state machine (not the workflow step machine). The subcommand:

1. Spawns a `design-facilitator` subagent (opus, `AskUserQuestion` only, pre-built EWH catalog injected, `maxTurns: 30`) that interviews the user until a structured proposal (`shape.json`) is emitted.
2. Shows a **shape gate** summarizing proposed artifacts (type, op=create|update, scope, role, frontmatter, dependencies). User approves / rejects / edits.
3. For each approved artifact, spawns an `artifact-author` subagent (sonnet) to generate the file body into `.ewh-artifacts/<run>/proposed/`.
4. Shows a **per-file gate** for each authored file (full body for creates, unified diff for updates). User approves / rejects / edits.
5. Per-file edits spawn an `artifact-refiner` subagent (sonnet) that takes the staged file + user's natural-language edit instruction and emits a revised version, which re-enters the per-file gate.
6. Shape-gate edits re-enter the facilitator with prior transcript context.
7. On full approval, writes staged files atomically to target paths in dependency order (rules → agents → workflows). Scope resolution: `scope: project` → `.claude/<path>`; `scope: plugin` → `<pluginRoot>/<path>` (hard-rejected outside the plugin repo).
8. Emits a `done` summary listing written paths.

The old `create` subcommand and its `{ kind: 'create'; ... }` `SubcommandState` variant are removed.

## Alternatives Considered

| Option | Rejected because |
|---|---|
| Upgrade `create` in place (keep name) | User prefers new name; `create` misleads when updates are in scope |
| Ambient (watch any conversation) | Surprising behavior; requires cross-cutting hook; out of scope |
| Binary-driven Q&A (one `user-prompt` per question) | Conversational UX degrades; every question is a state-machine round trip |
| Single free-discuss window (one `user-prompt` for entire interview) | Loses drift detection; no resumability within the window |
| Facilitator with filesystem tools | Unbounded context; facilitator tries to read the whole codebase |
| Facilitator writes all file bodies during interview | Interview cost scales with output verbosity; author agents keep interview cheap |
| All-or-nothing approval | No partial-edit UX; users rejecting one file restart everything |
| Per-file only (no shape gate) | Misses cheap early rejection on decomposition |
| User picks edit mechanism each time | One extra prompt with no typical benefit; auto-routing is almost always right |
| Internal workflow (`workflows/design.md`) | Pollutes workflow catalog; `design` modifies plugin internals, not user code |
| Hybrid subcommand+workflow | Two state shapes glued together; worst for readability |
| Command name `create` | Misleading for update flows |
| Command names `author`, `define`, `craft` | Less natural than `design` for "discuss before finalizing" |

## Acceptance Criteria

- `/ewh:doit design "<description>"` launches the facilitator; typical asks reach shape gate in ≤10 turns.
- Facilitator's `tools:` frontmatter contains only `AskUserQuestion` (verified by agent definition file).
- Every `AskUserQuestion` emitted by the facilitator includes a "propose now" option alongside topical choices.
- Shape gate validates every proposed path against the EWH catalog before display; invalid/hallucinated paths trigger facilitator re-entry with error context.
- Per-file gate shows full file body for `op: create`, unified diff for `op: update`.
- Crash after shape-gate approval is resumable via `.ewh-artifacts/<run>/state.json`; pre-shape-gate crash requires re-interview (documented, not fixed).
- In a non-plugin project, proposals with `scope: plugin` are auto-rewritten to `scope: project` with a one-line note to the user.
- Writes happen in dependency order: rules first, then agents, then workflows.
- The old `create` subcommand is removed; `/ewh:doit list` shows `design` in its place; `/ewh:doit create` returns an error pointing to `design`.
- New vitest coverage for each `design` phase transition.
- `/ewh:doit doctor --smoke` runs a scripted `design` session end-to-end.

## Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Entry point: new `/ewh:doit design` subcommand | Upgrade existing `create`; ambient | Explicit user-invoked command; no ambient surprise |
| 2 | Artifact scope: any combination of workflow/agent/rule, create or update | Workflow-only; create-only | Real use cases include revising existing artifacts |
| 3 | Discussion via facilitator subagent with `AskUserQuestion` only + catalog injection | Binary-driven Q&A; free-discuss window | Determinism at boundaries, natural dialogue inside; tools stripped to prevent codebase-reading |
| 4 | Two-tier approval (shape gate → per-file gates) | All-or-nothing; per-file only | Cheap early rejection on shape; fine polish on content |
| 5 | Auto edit routing: shape→facilitator, per-file→refiner | User picks each time | Matches user intent in typical cases; one fewer prompt |
| 6 | `design` supersedes `create` (remove old subcommand) | Coexist; wrap | User: always want conversation before finalizing |
| 7 | Interview stop: facilitator-driven + standing "propose now" option | User-only; facilitator-only; turn budget | User agency default; facilitator drives quality when allowed |
| 8 | Interview ephemeral; persist from shape gate onward | Full transcript persistence; full re-interview | Interviews short; real work is downstream |
| 9 | Shape-only facilitator + per-file author agents | Facilitator writes all bodies | Keeps interview cheap; per-file retry isolated |
| 10 | Command name `design` | `create`, `author`, `define`, `craft` | Covers both create and update; signals "discuss before finalize" |
| 11 | Subcommand impl (approach A) in `src/commands/design.ts` | Internal workflow; hybrid | Workflows = user code; subcommands = plugin ops. `tool-call` from subcommand state already supported. |
| 12 | Facilitator `maxTurns: 30` | 12 | Accommodate long discovery; "propose now" prevents runaway |
| 13 | Scope validation: `scope: plugin` hard-rejected outside plugin repo | User confirm each time | Safety default; prevents cross-project plugin edits |
| 14 | Write in dependency order: rules → agents → workflows | Arbitrary | Intra-batch references resolve after write |

## Assumptions

- Interview target length: ~5–10 turns; cap at 30.
- Scale: ≤ ~6 artifacts per session (1 workflow + ≤3 agents + ≤3 rules). Beyond that, facilitator suggests splitting.
- Facilitator uses opus (quality); author and refiner use sonnet (speed).
- Proposals stage under `.ewh-artifacts/<run>/proposed/`. On final approval, atomic writes (tmp → fsync → rename) to target paths.
- Plugin-repo detection: `package.json.name === "easy-workflow-harness"` (best-effort; wrong detection surfaces as a confirm prompt).
- Author agent retry on failure: uses existing `max_error_retries` (default 2) with the standard error-gate machinery.
- Catalog rebuilt on every invocation (no caching); ~50–100 lines total for a typical project.

## Implementation Notes (non-binding)

- New `SubcommandState` variants in `src/state/types.ts`: `{ kind: 'design'; phase: 'interview' | 'shape_gate' | 'author' | 'file_gate' | 'refine' | 'write'; ... }`.
- Remove `{ kind: 'create'; ... }` variants.
- New agents: `agents/design-facilitator.md`, `agents/artifact-author.md`, `agents/artifact-refiner.md`. All three emit `AGENT_COMPLETE` sentinel.
- `design-facilitator.md` frontmatter: `tools: [AskUserQuestion]`, `model: opus`, `maxTurns: 30`.
- Catalog builder: new helper in `src/commands/design.ts` that walks plugin `workflows/`, `agents/`, `rules/` and project `.claude/workflows/`, `.claude/agents/`, `.claude/rules/`, reading only frontmatter.
- Dispatcher (`skills/doit/SKILL.md`) needs no change — `tool-call` action kind is already supported from any state source.

## Risks

- Facilitator hallucinates catalog entries. Mitigation: shape-gate path validation; abort after 3 consecutive failures.
- Author agent writes invalid frontmatter. Mitigation: binary validates before per-file gate; one auto-retry.
- User approves, then regrets. Mitigation: `done` summary lists paths for `git checkout` reverts.

## Open Questions

- **Multi-session design flows.** If a session produces >6 artifacts and facilitator suggests splitting, how does the second session pick up the first session's output? Deferred — out of v1 scope.
- **Undo.** Currently relies on git. Worth a flag like `/ewh:doit design --undo <run-id>` later? Deferred.
- **Bulk updates.** User says "revise all rules in scope `feature/*`." Facilitator currently proposes one-by-one. Batch flow deferred.
