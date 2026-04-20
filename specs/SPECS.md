# Specs Index

## Active Decisions

- [status-resume-abort-doctor](status-resume-abort-doctor.md) — Four deferred v2 subcommands: `status`, `resume`, `abort`, `doctor` (single-turn pattern + gate-disambiguation for `resume`).

## TODO

Captured from a post-v2.0.1 audit (2026-04-19). Order is rough priority.

### Docs

- **User-facing documentation.** Post-v2 cleanup deleted five superseded design
  specs (`ewh-plugin-design`, `partial-output-handling`, `context-assembly-improvements`,
  `script-proposal`, `expand-tools`). Write new user-oriented documents that
  explain what the project is, how to install/use it, and the v2 architecture —
  replacing the role those specs implicitly played. Candidate locations:
  `README.md` (overview), `docs/architecture.md` (v2 binary + shim model),
  `docs/getting-started.md` (install, first workflow).
- **Addendum on `specs/dispatcher-binary-v2.md`** (now Superseded) explicitly
  listing what the spec promised but was deferred or removed: `auto_approve_start`
  removed in 2.0.1; `ewh status`/`abort`/`resume`/`doctor` subcommands not
  shipped; acceptance criterion #7 (`doctor` as CI smoke) punted. Keeps the
  accepted spec from contradicting shipped code.

### Subcommands deferred from v2 spec

- **`ewh status`** — read `.ewh-artifacts/<run>/ACTIVE` + `state.json`, report in-flight runs. Pure read; small effort.
- **`ewh resume`** — re-emit the stored instruction for the current run; `runReport` already does this idempotently. Small-medium effort. Together with `status`, these deliver on the crash-resume UX promised in README §Gates.
- **`ewh abort`** — already works as `ewh report --abort`; a standalone command is syntactic sugar. Low priority.
- **`ewh doctor`** — CI smoke / environment check; spec acceptance criterion #7. Medium effort, low urgency.

### Tests

- **Direct unit tests for subcommand state machines.** `init`, `create`, `expand-tools` currently only have indirect coverage via `tests/integration.test.ts` and `tests/subcommands.test.ts`. Add focused unit tests for each state machine's transitions.

### Open questions from v2 spec (still unresolved)

- **Windows native support** (Open Q #2). Hooks shell out to `node`; cross-platform in theory but unverified on Windows. Either test or scope README to macOS/Linux/WSL.
- **Context-fork SKILL.md** (Open Q #1). Deferred — can a subagent itself invoke the Agent tool? Would save more outer-session tokens if so.
- **`ewh replay <run_id>`** (Open Q #3). Stretch goal.
- **`@ewh/core` npm extraction** (Open Q #4). Deferred as premature.

### Small cleanups

- **`.gitattributes`**: mark `bin/ewh.mjs` as `linguist-generated=true` so GitHub collapses it in PRs and excludes it from language stats.
- **Automatic `.ewh-artifacts/` pruning.** Run folders accumulate indefinitely — every `/ewh:doit <workflow>` invocation creates a `run-<id>/` that's never reclaimed (observed: 22 folders in one project, most containing only `state.json` from aborted starts). Proposed: on `ewh start`, prune non-`ACTIVE` runs beyond a cap (default `max_runs: 10`, configurable in `.claude/ewh-state.json` under `artifact_retention`; `"keep"` opts out). Touches `src/state/store.ts`. Worth a brainstorming pass before implementing.

## Superseded

- [dispatcher-binary-v2](dispatcher-binary-v2.md) — Fully implemented in v2.0.0. Binary at `bin/ewh` + thin shim at `skills/doit/SKILL.md`; state machine in `src/state/machine.ts`; subcommands in `src/commands/`.
