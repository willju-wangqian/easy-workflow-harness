# Subcommand: clean-up

**Invoke:** `/ewh:doit clean-up`

Run a user-configured list of cleanup tasks — tests, linting, formatting, doc builds, or any custom commands. Tasks are stored in `.claude/ewh-state.json` and managed interactively.

## What It Does

1. Reads `cleanup_tasks` from `.claude/ewh-state.json`
2. If no tasks configured → prompts user to run `--manage-tasks`
3. Executes each task sequentially, reporting pass/fail
4. On failure: offers retry / skip / abort
5. Prints summary: N passed, N failed, N skipped

## Flags

| Flag | Effect |
|---|---|
| `--manage-tasks` | Enter task configuration mode instead of running tasks |
| `--no-override` | Force the built-in `clean-up` subcommand when a project workflow `.claude/workflows/clean-up.md` exists |

## Task Configuration (`--manage-tasks`)

**First-time setup:** The dispatcher scans the project for potential cleanup commands — `package.json` scripts, `Makefile` targets, Harness Config values, and common tool conventions. It proposes a task list and discusses with the user to refine it.

**Subsequent runs:** Shows the current task list and walks through each: edit / delete / skip. Then offers to add new tasks or reorder.

### Task Schema

Each task in `cleanup_tasks` has three fields:

```json
{
  "name": "run-tests",
  "command": "pytest",
  "description": "Run test suite"
}
```

- `name` — identifier shown in output
- `command` — shell command or path to a script, executed in the project root
- `description` — shown in management mode and summaries

## Example

```bash
# Configure tasks (first time)
/ewh:doit clean-up --manage-tasks

# Run configured tasks
/ewh:doit clean-up
```

```
Running cleanup tasks:

[1/3] run-tests: pytest ... PASS
[2/3] lint: ruff check . --fix ... PASS
[3/3] format: ruff format . ... PASS

Cleanup complete: 3 passed, 0 failed, 0 skipped
```

## Notes

- `clean-up` is a **subcommand**, not a workflow. It does not spawn agents, load rules, or run compliance checks.
- Tasks execute sequentially in the order listed — reorder via `--manage-tasks` if order matters (e.g., format before lint).
- If a project workflow `.claude/workflows/clean-up.md` exists, it takes precedence. Use `--no-override` to force the built-in subcommand.
- Unlike the previous `clean-up` workflow, this subcommand does **not** invoke `update-knowledge`. Run `/ewh:doit update-knowledge` separately for LLM reference file updates.
