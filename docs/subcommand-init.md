# Subcommand: init

**Invoke:** `/ewh:doit init`

Bootstrap a project for the Easy Workflow Harness — detect language, test framework, and conventions, then write a `## Harness Config` section to the project's CLAUDE.md. Finishes with an onboarding guide listing all available workflows and subcommands.

## What It Does

1. Scans the project for language, test command, check/lint command, source patterns, test patterns, doc build, and conventions
2. Proposes a `## Harness Config` section — shows preview, waits for confirmation
3. Writes to CLAUDE.md (creates the file if needed)
4. Updates `.gitignore` with `.ewh-artifacts/` and `.claude/ewh-state.json`
5. Prints an onboarding summary with all workflows, subcommands, and flags

## Flags

| Flag | Effect |
|---|---|
| `--no-override` | Force the built-in `init` subcommand when a project workflow `.claude/workflows/init.md` exists |

## Existing Config

If `## Harness Config` already exists in CLAUDE.md, the subcommand asks:

- **Overwrite** — replace the entire section with fresh detections
- **Update** — merge: keep existing values, add newly detected ones
- **Skip** — jump straight to the onboarding summary

## Onboarding Summary

After writing config (or skipping), `init` prints:

- All available **workflows** with descriptions
- All available **subcommands** with descriptions
- All **flags** with usage context
- **Next steps** suggesting `clean-up --manage-tasks`, `add-feature`, and `expand-tools`

## Example

```bash
/ewh:doit init
```

```
Detected:
  Language: TypeScript
  Test command: npm test
  Check command: eslint .
  Source pattern: src/**/*.ts
  ...

Write to CLAUDE.md? (confirm / edit / skip)
> confirm

Easy Workflow Harness is ready.

Workflows (multi-step, agent-driven):
  /ewh:doit add-feature [desc]      — plan, implement, review, and test a new feature
  ...

Next steps:
  - Run /ewh:doit clean-up --manage-tasks to configure your cleanup tasks
  ...
```

## Notes

- `init` is a **subcommand**, not a workflow. It does not spawn agents, load rules, or run compliance checks.
- If a project workflow `.claude/workflows/init.md` exists, it takes precedence. Use `--no-override` to force the built-in subcommand.
