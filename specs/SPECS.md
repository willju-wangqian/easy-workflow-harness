# Specs Index

## Active Decisions

_None at this time._

## TODO

- **User-facing documentation.** Post-v2 cleanup deleted five superseded design
  specs (`ewh-plugin-design`, `partial-output-handling`, `context-assembly-improvements`,
  `script-proposal`, `expand-tools`). Write new user-oriented documents that
  explain what the project is, how to install/use it, and the v2 architecture
  — replacing the role those specs implicitly played. Candidate locations:
  `README.md` (overview), `docs/architecture.md` (v2 binary + shim model),
  `docs/getting-started.md` (install, first workflow).

## Superseded

- [dispatcher-binary-v2](dispatcher-binary-v2.md) — Fully implemented in v2.0.0. Binary at `bin/ewh` + thin shim at `skills/doit/SKILL.md`; state machine in `src/state/machine.ts`; subcommands in `src/commands/`.
