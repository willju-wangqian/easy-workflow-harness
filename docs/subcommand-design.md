# Subcommand: design

**Invoke:** `/ewh:doit design "<describe what you want>"`

Design one or more EWH artifacts (workflows, agents, rules — any mix of new or updated) through a conversational interview. The dispatcher spawns a facilitator subagent that interviews the user, proposes a shape, gates on the shape, then authors and gates each file individually before writing.

Replaces the former `create` subcommand. Covers both create and update flows, and handles multi-artifact batches in a single session.

## What It Does

1. **Interview.** A `design-facilitator` subagent (opus, `AskUserQuestion`-led) interviews the user until it can emit a structured `shape.json` proposal. Every question includes a "propose now" option so the user can skip ahead.
2. **Shape gate.** Binary validates every proposed path against the EWH catalog, then shows a summary (type, op, scope, path, frontmatter, dependencies) and waits for approve / reject / edit. Edits re-enter the facilitator with prior-transcript context.
3. **Per-file authoring.** For each approved artifact, an `artifact-author` subagent (sonnet) generates the file body into `.ewh-artifacts/<run>/proposed/`.
4. **Per-file gate.** Each staged file is shown: full body for `op: create`, unified diff for `op: update`. User approves, rejects, or edits. Edits spawn an `artifact-refiner` subagent that applies the natural-language instruction and re-enters the per-file gate.
5. **Atomic writes.** On full approval, staged files are written to their target paths atomically (tmp → fsync → rename) in dependency order: rules → agents → workflows.
6. Emits a `done` summary listing written paths (useful for `git checkout` reverts).

## Flags

| Flag | Effect |
|---|---|
| `--no-override` | Force the built-in `design` subcommand when a project workflow `.claude/workflows/design.md` exists |

## Scope and Target Paths

Each artifact in the proposal has a `scope`:

- **`scope: project`** → written under the project's `.claude/` (`.claude/workflows/`, `.claude/agents/`, `.claude/rules/`).
- **`scope: plugin`** → written under the plugin repo itself. Rejected outside the plugin repo; auto-rewritten to `scope: project` with a note to the user. Inside the plugin repo, a `scope: project` artifact triggers an explicit confirmation prompt before proceeding.

Plugin-repo detection uses `package.json.name === "easy-workflow-harness"` (best-effort; a wrong guess surfaces as a confirm prompt rather than a silent write).

## Artifact Types and Required Frontmatter

### Rules

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `scope` | Tags (e.g., `[code, security]`) |
| `severity` | `default` or `critical` |
| `inject_into` | Target agent names |
| `verify` | Shell command for compliance checking (required for `severity: critical`) |

### Agents

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `model` | `sonnet`, `haiku`, or `opus` |
| `tools` | Tool list (respecting read-only / read-write tier) |
| `maxTurns` | Maximum turn count |
| `incremental` | Optional. `true` marks the agent as a list-producer eligible for chunked-dispatch incremental writes (scanner / reviewer / tester pattern). When set, the dispatcher pre-creates each chunk artifact with an append anchor and instructs the agent to `Edit`-append per finding so partial progress survives turn-cap truncation. Requires `Edit` in `tools:`. |

Body must include a `## Before You Start` self-gating section and an `AGENT_COMPLETE` sentinel instruction. The author agent injects both by default.

### Workflows

| Field | Description |
|---|---|
| `name` | Kebab-case identifier |
| `description` | One-line summary |
| `trigger` | `/ewh:doit <name>` |
| `steps` | Sequence of step definitions |

Each step needs: `name`, `agent`, `gate`, `rules`, `description`. Optional step fields: `artifact`, `reads`, `requires`, `context`, `chunked`, `script`, `script_fallback`.

## Catalog and Validation

On every invocation, the dispatcher rebuilds an EWH artifact catalog by reading frontmatter from plugin `workflows/`, `agents/`, `rules/` and project `.claude/workflows/`, `.claude/agents/`, `.claude/rules/`. The catalog is injected into the facilitator's task as a JSON file path — the facilitator cannot read project source code directly (tool list is `AskUserQuestion`, `Read`, `Write` scoped to the catalog + shape paths).

The shape gate hard-validates every proposed path against the catalog:

- `op: create` paths must not already exist in the catalog.
- `op: update` paths must match an existing catalog entry.

Validation failures bounce back to the facilitator with error context; after 3 consecutive failures the run aborts.

## Crash Resume

State writes atomically to `.ewh-artifacts/<run-id>/state.json` on every transition. After the shape gate, a crash resumes cleanly via `ewh report`. Pre-shape-gate crashes lose the interview transcript and require re-interviewing — this is documented, not fixed (interviews are short; real work is downstream).

## Example

```bash
/ewh:doit design "a security rule that forbids raw SQL in the data access layer"
```

```
Interviewing...

[facilitator] What should trigger this rule — any SQL construction in src/, or only certain patterns?
  - only raw string concatenation passed to execute()
  - any call to cursor.execute() / session.execute() with a non-parameterized arg
  - both
  - propose now

> both

[facilitator] Should this rule block workflows (critical) or warn only (default)?
  - critical
  - default
  - propose now

> critical

EWH design — shape gate

Proposal: a security rule that forbids raw SQL in the data access layer

  1. [create rule] no-raw-sql → .claude/rules/no-raw-sql.md
       severity: critical  scope: [code, security]  inject_into: [coder, reviewer]

Approve (yes) / reject (no) / edit?
> yes

Authoring .claude/rules/no-raw-sql.md ...

EWH design — file gate 1/1

--- staged file body ---
---
name: no-raw-sql
description: Forbid raw SQL queries — all database access must use parameterized statements
scope: [code, security]
severity: critical
inject_into: [coder, reviewer]
verify: "grep -rn 'execute(' src/ | grep -v 'parameterized' | head -5"
---
...

Approve / reject / edit?
> yes

Wrote: .claude/rules/no-raw-sql.md
```

## Notes

- `design` is a **subcommand**, not a workflow. It uses the lightweight `SubcommandState` state machine, not the workflow step machine. No rules loader, no compliance checks, no artifact workspace beyond the staging dir.
- Facilitator uses opus (quality); author and refiner use sonnet (speed).
- There is no undo — rely on git. The `done` summary lists written paths to make `git checkout` reverts easy.
- Prefer `/ewh:doit design` over manually creating agent / rule / workflow files. Hand-edited files bypass the shape gate and catalog validation.
- If a project workflow `.claude/workflows/design.md` exists, it takes precedence. Use `--no-override` to force the built-in subcommand.
- Invoking `/ewh:doit create …` emits a deprecation message pointing to `design`. The old `create` subcommand is removed.
