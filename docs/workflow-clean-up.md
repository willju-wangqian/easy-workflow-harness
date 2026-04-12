# Workflow: clean-up

> Source: [`workflows/clean-up.md`](../workflows/clean-up.md)

Full repo health check — run tests, linter, doc build, then update documentation.

## When to Use

For routine maintenance — verify everything builds, passes, and is documented. Runs the full gauntlet of checks and finishes by updating docs via the `update-knowledge` sub-workflow.

```bash
/ewh:doit clean-up
```

## Steps

### 1. test (auto gate)

- **Agent**: none (dispatcher runs command directly)
- **Rules**: `testing`

Runs the test command from Harness Config (e.g., `pytest`, `npm test`, `cargo test`). If tests fail, the workflow gates and reports failures before proceeding.

### 2. check (auto gate)

- **Agent**: none (dispatcher runs command directly)
- **Rules**: none
- **Context**: test (summary)

Runs the check command from Harness Config (e.g., `ruff check .`, `npm run lint`, `cargo clippy`). Reports any failures.

### 3. build-docs (auto gate)

- **Agent**: none (dispatcher runs command directly)
- **Rules**: none
- **Context**: test (summary), check (summary)

Runs the doc build command from Harness Config. If the project has a README source (README.Rmd, README.qmd, etc.), renders it too. Reports build errors.

### 4. update-knowledge (auto gate)

- **Agent**: none (triggers sub-workflow)
- **Rules**: `knowledge`
- **Context**: test (summary), check (summary), build-docs (summary)

Triggers the [`update-knowledge`](workflow-update-knowledge.md) workflow as a sub-workflow. Prior steps context carries forward. Updates CLAUDE.md and project docs based on current state.
