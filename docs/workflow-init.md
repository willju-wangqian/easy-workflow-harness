# Workflow: init

> Source: [`workflows/init.md`](../workflows/init.md)

Bootstrap a project for EWH — detects language, test framework, and conventions, then appends a Harness Config section to your CLAUDE.md.

## When to Use

Run this once when adopting EWH in a new project. It scans your project structure and sets up the configuration that all other workflows depend on.

```bash
/ewh:doit init
```

## Steps

### 1. scan (auto gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: none

The dispatcher scans the project root for marker files to auto-detect:
- Language/framework (`package.json` → JS/TS, `pyproject.toml` → Python, `Cargo.toml` → Rust, etc.)
- Test framework (`pytest`, `jest`, `vitest`, `cargo test`, etc.)
- Source file patterns from project structure
- Existing CLAUDE.md and `.claude/` directory contents

### 2. propose (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: `knowledge`

Presents detected configuration to the user for confirmation:
- Language, test command, check command, source patterns, conventions
- What already exists in CLAUDE.md vs. what will be appended
- Any conflicts between existing content and harness expectations

No changes are made until you confirm.

### 3. apply (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: `knowledge`

Appends the `## Harness Config` section to CLAUDE.md. Never overwrites existing content. Also ensures `.ewh-artifacts/` is in the project's `.gitignore`.

Shows you exactly what will be written before writing it.
