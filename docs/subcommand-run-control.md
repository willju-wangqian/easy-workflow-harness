# Subcommands: status / resume / abort / doctor

**Invoke:** `/ewh:doit status`, `/ewh:doit resume [<run-id>]`, `/ewh:doit abort [<run-id>]`, `/ewh:doit doctor [--smoke]`

Four single-turn subcommands that manage the lifecycle of `.ewh-artifacts/run-*/` directories and validate the plugin environment. Shipped per `specs/status-resume-abort-doctor.md`. Shared implementation: `src/state/store.ts:scanRuns`; individual commands in `src/commands/{status,resume,abort,doctor}.ts`.

## `status`

Lists all runs in the current project's `.ewh-artifacts/` with one row per run.

**Active case** — one row per running run and/or stale run:

```
5b2a3c1d  add-feature    step-3/5    agent_run        12m ago
[stale]   7f9e0d4a  refine-feature  step-2/4  continuation  2d ago  — run `ewh abort 7f9e0d4a`
```

Columns: `run-id  workflow  step-N/T (or "subcommand")  phase  age`. Natural 2-space separators, grep-friendly. When any stale row is present, a left-margin `[stale] ` tag distinguishes rows.

**Empty case** — no active and no stale runs:

```
No active runs.
Last: a7b3c8d2  add-feature  complete  3h ago
(4 completed runs retained for debug · max_runs=10)
```

The `Last:` line surfaces the most recent terminal run so you can resume or inspect. The footer shows how many `run-*` directories are kept on disk (governed by `artifact_retention.max_runs` in `.claude/ewh-state.json`; default 10, `"keep"` opts out).

**Stale detection** — a run is stale when:
- Its `ACTIVE` marker contains a dead PID (`process.kill(pid, 0)` fails), OR
- The PID is live but the state hasn't moved in >48h (covers PID recycling where an unrelated process inherits the stored PID).

`scanRuns` deletes stale markers on sight so `pruneOldRuns` can reclaim the run directory under the cap.

Exit code: `0` always (`status` never fails).

## `resume`

Re-emits the stored pending instruction for a run **idempotently** — no state mutation, no drift-log advance. Safe to call after a crash or disconnect.

- **`resume <run-id>`**:
  - Run is terminal (`complete`/`aborted`) → prints final summary, exit 0.
  - Run is `running` → re-emits the stored pending instruction.
  - Run not found → error, exit 1.
- **`resume` (no id)**:
  - 0 runs exist → `No runs to resume.`, exit 0.
  - 0 active + terminal runs exist → prints summary of most-recent terminal.
  - 1 active → re-emits that run's instruction.
  - **>1 active** → emits a gate listing active runs; you pick via `ewh report --decision <run-id>`. The pick is stored in `SubcommandState` (phase `resume_pick`), then the chosen instruction is re-emitted.

## `abort`

Marks a run `aborted`, clears its `ACTIVE` marker, and prints the same output as `ewh report --abort`.

- **`abort <run-id>`** — delegates to `runReport({ abort: true })`. Errors if the run isn't `running`.
- **`abort` (no id)**:
  - Exactly one run is eligible (active OR stale) → aborts it.
  - 0 eligible → `no active run to abort`, exit 1.
  - >1 eligible → error listing IDs, suggests `ewh abort <run-id>`, exit 1.

This is the canonical cleanup path for stale runs that `status` flags — the single-argument hint in the `[stale]` row copies cleanly into the terminal.

## `doctor`

Validates the plugin environment. Default runs checks 1–10; `--smoke` adds check 11.

| # | Check | Fail level |
|---|---|---|
| 1 | Node version ≥ `engines.node` in `package.json` | fail |
| 2 | `bin/ewh.mjs` exists + executable | fail |
| 3 | Plugin root has `workflows/`, `agents/`, `rules/` | fail |
| 4 | `.ewh-artifacts/` writable (probe write/delete) | fail |
| 5 | `.claude/ewh-state.json` parses (if present) | warn |
| 6 | Project `CLAUDE.md` has `## Harness Config` section | warn |
| 7 | `hooks/hooks.json` parses | warn |
| 8 | Each `agents/*.md` has valid frontmatter + `AGENT_COMPLETE` literal | fail |
| 9 | Each `rules/**/*.md` has valid frontmatter | fail |
| 10 | Each `workflows/*.md` parses; step `agent:` and `rules:` resolve | fail |
| 11 | `--smoke`: `mkdtemp` → `ewh start list` → assert `ACTION: done` → cleanup | fail |

Output shape:

```
ewh doctor
  ✓ node version (v22.x)
  ✓ binary present
  ✗ plugin agents (2 issues)
      agents/foo.md: missing AGENT_COMPLETE sentinel
  ! ewh-state.json (warning: 1 issue)
SUMMARY: 1 fail, 1 warn, 9 pass
```

**Exit codes**: `0` all pass, `1` warnings only, `2` any fail. Use `doctor --smoke` in CI for a full round-trip health check.

## Flags

| Flag | Applies to | Effect |
|---|---|---|
| `--smoke` | `doctor` | Adds check 11 (end-to-end dry-run via `ewh start list` in a temp dir) |
| `--no-override` | all | Force the built-in subcommand when a same-name project workflow exists in `.claude/workflows/` |

None of the four accept `--trust`, `--yolo`, `--max-retries`, `--save`, or `--strict` — those are workflow-gate flags and don't apply to single-turn run-control commands.

## Related

- `specs/status-resume-abort-doctor.md` — design decisions, decision log, acceptance criteria.
- `CHANGELOG.md` 2.0.3 — PID-based stale detection, 48h age heuristic, `[stale]` tagging, status retention footer.
- `src/state/store.ts` — `scanRuns`, `pruneOldRuns`, PID-liveness helper.
