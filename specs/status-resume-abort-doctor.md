---
name: status-resume-abort-doctor
type: reference
scope: [dispatcher, subcommands, cli]
created: 2026-04-19
---

# Deferred v2 Subcommands: status / resume / abort / doctor

Implements the four subcommands deferred from `dispatcher-binary-v2.md`
(spec §Deferred, acceptance criterion #7). Closes the crash-resume UX
promised in `README.md` §Gates and delivers a CI-friendly environment
check.

## Understanding Summary

- **What:** Four single-turn subcommands — `ewh status`, `ewh resume [<run-id>]`,
  `ewh abort [<run-id>]`, `ewh doctor [--smoke]`.
- **Why:** Deliver crash-resume visibility; close v2 spec acceptance
  criterion #7; make the "binary drives" contract observable.
- **For whom:** Plugin users recovering from interruption; CI pipelines
  wanting a health check.
- **Constraints:** Follow existing `src/commands/list.ts` pattern;
  pure single-turn where possible; `resume` multi-turn only for >1
  active disambiguation.
- **Non-goals:** No `--json` output (defer); no user-scoped state
  scanning (current project only); no new `RunState` fields; no new
  agents/rules.

## Decision

### File layout

```
src/commands/
  status.ts      single-turn; scans .ewh-artifacts/
  resume.ts      single-turn (common) or multi-turn (disambiguation gate)
  abort.ts      single-turn; delegates to runReport({ abort: true })
  doctor.ts      single-turn; optional --smoke runs dry-run
```

### Dispatcher wiring

`src/commands/start.ts`:
```ts
export const BUILTIN_SUBCOMMANDS = [
  'list', 'init', 'cleanup', 'create', 'expand-tools',
  'status', 'resume', 'abort', 'doctor',
] as const;
```

Name resolution unchanged; project override still wins unless `--no-override`.

### Shared helper in `src/state/store.ts`

```ts
export type RunSummary = {
  run_id: string;
  workflow: string;
  status: 'running' | 'complete' | 'aborted';
  current_step_index: number;
  total_steps: number;
  current_phase: string;
  is_active: boolean;        // ACTIVE marker present
  updated_at: string;
};

export async function scanRuns(projectRoot: string): Promise<RunSummary[]>;
```

`scanRuns` reads `.ewh-artifacts/run-*/state.json`; missing dir → `[]`;
malformed state → stderr warn + skip. Sort: `is_active && running` first,
then `updated_at` desc.

### `ewh status` behavior

- Scans runs; emits one line per active run:
  `<run-id>  <workflow>  step-<N>/<T>  <phase>  <age>`
  (natural 2-space separators, grep-friendly).
- If no active runs: `No active runs.` plus (when a terminal run exists)
  `Last: <run-id>  <workflow>  <status>  <age>`.
- Age format: relative (`5m ago`, `2h ago`, `3d ago`).
- Exit 0 always.

### `ewh resume [<run-id>]` behavior

- `<run-id>` provided:
  - Terminal (`complete`/`aborted`) → print final summary, exit 0.
  - `running` → re-emit the stored instruction idempotently (no state
    mutation, no drift-log advance), exit 0.
  - Not found → error exit 1.
- `<run-id>` omitted:
  - 0 active + terminal runs exist → print summary of most-recent terminal.
  - 0 active + 0 runs → `No runs to resume.` exit 0.
  - 1 active → re-emit that run's current instruction.
  - >1 active → **emit a gate** listing active runs; user picks via
    `ewh report --decision <run-id>`. Binary stores pick in
    `SubcommandState` (phase `resume_pick`), then re-emits chosen
    instruction.

Adds helper `reEmitCurrentInstruction(projectRoot, pluginRoot, runId)` —
reads state and formats the pending instruction the same way
`runReport` does, without mutations.

### `ewh abort [<run-id>]` behavior

- `<run-id>` provided → delegate to existing `runReport({ abort: true })`;
  error if run not `running`.
- `<run-id>` omitted:
  - 1 active → abort that one.
  - 0 active → error `no active run to abort`, exit 1.
  - >1 active → error listing IDs, suggest `ewh abort <run-id>`, exit 1.
- No new state mutation; `runReport` handles `clearActive` + state update.

### `ewh doctor [--smoke]` behavior

Checks (default: 1–10; `--smoke` adds 11):

| # | Check | Fail level |
|---|---|---|
| 1 | Node version ≥ `engines.node` | fail |
| 2 | `bin/ewh.mjs` exists + executable | fail |
| 3 | Plugin root has `workflows/`, `agents/`, `rules/` | fail |
| 4 | `.ewh-artifacts/` writable (probe) | fail |
| 5 | `.claude/ewh-state.json` parses | warn |
| 6 | CLAUDE.md has `## Harness Config` section | warn |
| 7 | `hooks/hooks.json` parses | warn |
| 8 | Each `agents/*.md` valid frontmatter + `AGENT_COMPLETE` literal | fail |
| 9 | Each `rules/**/*.md` valid frontmatter | fail |
| 10 | Each `workflows/*.md` parses; step agents/rules resolvable | fail |
| 11 | `--smoke`: `mkdtemp` → `ewh start list` → assert `ACTION: done` → cleanup | fail |

Output:
```
ewh doctor
  ✓ node version (v22.x)
  ✓ binary present
  ✗ plugin agents (2 issues)
      agents/foo.md: missing AGENT_COMPLETE sentinel
  ! ewh-state.json (warning: 1 issue)
SUMMARY: 1 fail, 1 warn, 9 pass
```

Exit codes: `0` all pass, `1` warnings only, `2` any fail.

### Error handling (all four)

- Malformed `state.json` → stderr warn + skip; don't abort the command.
- Missing `.ewh-artifacts/` → treat as empty.
- Stale `ACTIVE` (state terminal but marker present) → `status` ignores
  in active count; `doctor` flags as warning.

## Alternatives Considered

- **Approach B (grouped `run-control/` module):** Rejected — only
  `status` scans; `resume`/`abort` act on single runs. Premature grouping.
- **Approach C (extend `ewh report` with flags):** Rejected by spec —
  SPECS asks for explicit subcommands as UX sugar; `report` already
  flag-heavy.
- **`status` multi-line / `--verbose` / `--json` tiers:** Deferred.
  One-line grep-friendly output covers the current UX; add tiers
  when a real need surfaces.
- **`resume` auto-pick newest on >1 active:** Rejected — user chose
  gate prompt (Q4) for least-surprise.
- **`resume` on terminal run errors out:** Rejected — user chose
  informational summary (Q5) to match idempotent spirit.
- **`doctor --smoke` uses a dedicated no-op workflow:** Rejected —
  `ewh start list` is already single-turn and side-effect-free; no
  new files needed.

## Acceptance Criteria

1. `ewh status` lists all active runs in the current project; empty case
   shows last terminal run.
2. `ewh resume` on a single active run re-emits its pending instruction
   without state mutation.
3. `ewh resume` on >1 active runs emits a disambiguation gate.
4. `ewh abort <run-id>` marks the run `aborted`, clears `ACTIVE`, and
   matches `ewh report --abort` output.
5. `ewh doctor` validates plugin structure + frontmatter; exit 2 on any
   fail, 1 on warn-only, 0 on clean.
6. `ewh doctor --smoke` completes a dry-run `start → report` cycle in a
   temp dir and cleans up.
7. Unit tests cover `scanRuns` (empty / corrupt / stale-ACTIVE / multi-run)
   and each subcommand's state transitions.
8. Integration test: start a workflow, simulate crash, verify `status`
   shows it, `resume` re-emits the same instruction.

## Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Ship all four subcommands together | status+resume only | User request |
| 2 | Branch off `origin/main` not `main` | `main` (pruning WIP) | Pruning WIP unfinished; isolate |
| 3 | Approach A (parallel subcommands) | B (grouped), C (extend report) | Matches `list.ts`; minimal surface |
| 4 | `status` = 1 line per run, no columns | Multi-line; `--verbose`/`--json` | Grep-friendly; defer tiers |
| 5 | Empty `status` shows last terminal run | Silent; runs-only | Helps locate run to `resume` |
| 6 | `resume` >1 active → gate prompt | Auto-pick newest; hard error | Least surprise |
| 7 | `resume` terminal run → final summary, exit 0 | Error; re-run | Informational; idempotent spirit |
| 8 | `abort` auto-picks when 1 active | Always require `<id>` | Symmetric with `resume` |
| 9 | `doctor` default checks 1–10 + `--smoke` adds 11 | All-in-one; minimal | User chose c + optional d |
| 10 | `doctor` exit 0/1/2 (pass/warn/fail) | 0/1 only | CI distinguishes warn from fail |
| 11 | `doctor --smoke` uses `ewh start list` in mkdtemp | Dedicated no-op workflow | Zero new files; `list` side-effect-free |
| 12 | Current project only | Include user-scoped state | Matches dispatcher scope |
| 13 | Add `scanRuns()` helper to `store.ts` | Inline per command | Shared; one scan path |
| 14 | `RunState` schema unchanged | Add `resume_pick` field | Reuse `SubcommandState.phase` |
| 15 | Malformed `state.json` → warn + skip | Abort command | Must tolerate corrupt runs |
