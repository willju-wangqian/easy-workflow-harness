# Workflow: refine-feature

> Source: [`workflows/refine-feature.md`](../workflows/refine-feature.md)

Scan existing code for improvement opportunities, propose fixes, implement approved changes, then review and test.

## When to Use

When you want to improve existing code — not build something new. The scanner identifies issues first, then you pick which ones to fix.

```bash
/ewh:doit refine-feature "optimize the database query layer"
```

## Steps

### 1. scan (auto gate)

- **Agent**: `scanner` (sonnet)
- **Rules**: `review`
- **Artifact**: `.ewh-artifacts/scan-findings.md`

The scanner analyzes the target code area for improvement opportunities. Reports findings organized by severity (critical/warning/nit). Does not fix anything — investigation only.

### 2. propose (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: none
- **Reads**: `.ewh-artifacts/scan-findings.md`
- **Context**: scan (full)
- **Artifact**: `.ewh-artifacts/approved-improvements.md`
- **Requires**: scan artifact exists

Presents scan findings to you for approval. You select which improvements to implement. This is a decision gate — no changes happen until you confirm.

### 3. code (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `coding`
- **Reads**: `.ewh-artifacts/approved-improvements.md`
- **Context**: propose (full)
- **Requires**: approved improvements artifact exists

Implements only the approved improvements. Follows coding rules and project conventions. Runs tests after changes.

### 4. review (auto gate)

- **Agent**: `reviewer` (sonnet)
- **Rules**: `review`
- **Context**: code (full)
- **Requires**: code step modified files

Reviews all changes for bugs, quality issues, and rule compliance.

### 5. test (auto gate)

- **Agent**: `tester` (sonnet)
- **Rules**: `testing`
- **Context**: code (full), review (summary)
- **Requires**: code step modified files

Writes or updates tests for the refined code, covering any new behavior introduced by improvements.
