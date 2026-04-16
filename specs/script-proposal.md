---
name: script-proposal
type: decision
status: accepted
scope: [dispatcher, workflows, token-optimization]
created: 2026-04-16
version: 1.0.2
---

# Script Proposal — Dispatcher Suggests Scripts for Mechanical Steps

## Understanding Summary

- **What**: Dispatcher detects when workflow steps can be executed as shell scripts instead of LLM agents, proposes scripts to the user, and caches approved scripts for reuse
- **Why**: LLM agents are overkill for mechanical steps (linting, formatting, file operations, running test suites). Scripts are faster, cheaper, and deterministic
- **Who**: EWH users running workflows with mechanical steps, and workflow authors who want to pre-define scriptable steps
- **Non-goals**: No non-Bash languages (unless Harness Config specifies), not replacing the agent system, no silent script injection without user awareness

## Design

### Step Schema Extensions

Two new optional fields on workflow steps:

- `script:` — path to a pre-defined script. If set, dispatcher runs it directly (skips scriptability evaluation). If omitted, dispatcher checks for cached scripts then evaluates scriptability.
- `script_fallback: gate | auto` — controls behavior on script failure. `gate`: stop, show error, offer retry/edit/agent-fallback/skip/abort. `auto`: silently spawn the step's agent. Default: `gate`.

### `--manage-scripts` Flag

Syntax: `/ewh:doit <name> --manage-scripts [description]`

Inserted into Startup Sequence between §4b and §5. Scans `.claude/ewh-scripts/<workflow>/` for cached scripts. Presents a table; for each: (v)iew / (e)dit / (d)elete / (r)egenerate / (s)kip. Completes before the workflow proceeds.

### §1d Script Resolution

New dispatcher section after §1c (Chunked Dispatch), before §2 (Resolve Executor). Runs for every step.

1. **Explicit script** — if `step.script` is set, read the file. If exists → execute. If missing → warn, fall through to evaluate.
2. **Cached script** — check `.claude/ewh-scripts/<workflow>/<step>.sh`. If exists, staleness check via sha256 hash of step description stored in header (`# ewh-hash: <hash>`). If stale → ask user: view / regenerate / use anyway. If not stale → log path + summary, execute.
3. **Evaluate scriptability** — LLM judgment based on step description, agent assignment, rules, Harness Config, prior step context. If uncertain → ask user. If clearly scriptable → propose. If clearly not → skip to §2.
4. **Generate script** — on user agreement, generate Bash script. User collaboration loop: approve / reject / edit / regenerate with guidance. On approve → write to `.claude/ewh-scripts/<workflow>/<step>.sh` with header (hash, summary, `set -euo pipefail`). On reject → fall through to §2.
5. **Execute** — run via Bash. Exit 0 → capture output, compress to step summary, proceed to §6e/§7. Non-zero → apply `script_fallback`.

### Consecutive Step Merging

When consecutive steps all have resolved scripts, evaluate merge eligibility:
- No `gate: structural` between steps
- No intra-group `reads:` dependencies
- No `severity: critical` rules in the group

If eligible and group size > 1 → propose merge to user. Merged script concatenated with section markers (`# --- Step: <name> ---`). Saved to `.claude/ewh-scripts/<workflow>/_merged_<first>_to_<last>.sh`. On partial failure, identify failing section, apply that step's `script_fallback`, run remaining individually.

### Script File Format

```bash
#!/usr/bin/env bash
# ewh-hash: <sha256 of step description>
# ewh-summary: <one-line description>
set -euo pipefail

<script body>
```

### Changes to Existing Sections

- **Invocation**: add `--manage-scripts` to syntax
- **Startup Sequence**: new §4c for `--manage-scripts` handling
- **Step Execution Loop**: new §1d; §2 unchanged (§1d resolves or falls through)
- **§6**: script-executed steps produce summaries in same format for downstream `context:`
- **§8 Error Handling**: add row for script failure → `script_fallback`
- **Completion**: `.ewh-scripts/` is persistent (not cleaned up)
- **HARNESS.md**: add `.claude/ewh-scripts/` path, bump version to 1.0.2
- **CLAUDE.md**: document new fields, flag, and directory

### Edge Cases

- **Chunked + scriptable**: mutually exclusive. §1c runs first; chunked steps skip §1d entirely.
- **`script:` + `agent:`**: valid. Agent is the fallback for `script_fallback: auto`.
- **Deleted `.claude/ewh-scripts/`**: treated as no cached scripts, re-evaluates on next run.
- **Script artifacts**: §6e artifact verification runs identically for script-executed steps.
- **Compliance after scripts**: §7 unchanged. Critical rules still trigger compliance agent.

## Alternatives Considered

| Approach | Why rejected |
|---|---|
| Script as executor type inside §2 | Bloats §2's already-heavy branching; harder to reason about |
| Two-pass pre-processing scan | Proposes scripts for later steps without full context from earlier steps |
| Keyword heuristics for scriptability | Brittle; LLM + user collaboration is more accurate |
| Always merge consecutive scripts | Violates gate boundaries and compliance granularity |
| Scripts inline in workflow YAML | Large scripts waste tokens when LLM reads workflow files |
| Scripts in ewh-state.json | Same problem; single large file |

## Decision Log

| # | Decision | Why |
|---|----------|-----|
| 1 | Hybrid: `script:` field + runtime LLM evaluation | Balances pre-defined scripts with opportunistic discovery |
| 2 | Individual files in `.claude/ewh-scripts/<workflow>/<step>.sh` | Each script loaded only when needed |
| 3 | LLM judgment for scriptability, asks user when uncertain | Mechanical heuristics are brittle |
| 4 | Individual scripts default, merge when consecutive + no structural gates | Respects gate boundaries while capturing optimization |
| 5 | `script_fallback: gate \| auto` per step | User/author controls trade-off per step |
| 6 | Full collaboration loop (approve/reject/edit/regenerate) | Users need full control over scripts in their environment |
| 7 | `--manage-scripts` single flag for pre-run management | Simple UX, full CRUD |
| 8 | Cached scripts: path + summary, no gate | Transparent but non-blocking |
| 9 | Staleness via sha256 hash in script header | Content-based detection is accurate and cheap |
| 10 | Chunked and scriptable mutually exclusive | Orthogonal purposes |

## Acceptance Criteria

1. Steps with `script:` field execute the referenced script instead of spawning an agent
2. Dispatcher detects scriptable steps and proposes scripts to user with collaboration loop
3. Approved scripts cached in `.claude/ewh-scripts/<workflow>/<step>.sh` with hash/summary headers
4. Cached scripts execute on subsequent runs with path + summary log (no gate)
5. Stale scripts (description changed) are flagged for user review
6. `script_fallback: gate` stops on failure; `script_fallback: auto` falls back to agent
7. Consecutive eligible scripts can be merged into one with section markers
8. `--manage-scripts` flag provides view/edit/delete/regenerate for cached scripts before run
9. Existing workflows without script fields behave identically (zero regression)
