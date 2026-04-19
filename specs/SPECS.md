# Specs Index

## Active Decisions

- [dispatcher-binary-v2](dispatcher-binary-v2.md) — Clean rewrite of the dispatcher as a Node/TS binary with a thin SKILL.md shim; step-by-step reactive driver, file-indirection for prompts, state machine replacing §1c/§1d/§6c/§6a/§6b prose (v2.0.0)

## Superseded

- [partial-output-handling](partial-output-handling.md) — Superseded by [dispatcher-binary-v2](dispatcher-binary-v2.md). Continuation/split/merge now live as `continuation`, `split`, `split_merge` phases in `src/continuation/`.
- [context-assembly-improvements](context-assembly-improvements.md) — Superseded by [dispatcher-binary-v2](dispatcher-binary-v2.md). Context assembly moves into `src/workflow/prompt-builder.ts`.
- [script-proposal](script-proposal.md) — Superseded by [dispatcher-binary-v2](dispatcher-binary-v2.md). Script resolution implemented as `script_eval`/`script_propose`/`script_run` phases in `src/scripts/`.
- [expand-tools](expand-tools.md) — Superseded by [dispatcher-binary-v2](dispatcher-binary-v2.md). Implemented as the `ewh expand-tools` binary subcommand.
- [ewh-plugin-design](ewh-plugin-design.md) — Superseded by [dispatcher-binary-v2](dispatcher-binary-v2.md). Packaging decisions now captured in the plugin manifest and v2 spec.
