# Workflow: fact-check

> Source: [`workflows/fact-check.md`](../workflows/fact-check.md)

Cross-validate documentation against source code — find and fix stale claims.

## When to Use

When you suspect documentation has drifted from reality. Checks that file paths exist, function names match, dependency lists are accurate, and architecture descriptions reflect the actual code.

```bash
/ewh:doit fact-check "verify README and CLAUDE.md are accurate"
```

## Steps

### 1. scan-docs (auto gate)

- **Agent**: `scanner` (sonnet)
- **Rules**: `knowledge`
- **Artifact**: `.ewh-artifacts/claims-checklist.md`

Scans all maintained documentation (CLAUDE.md, specs, memory files, README) for factual claims about the codebase: function names, file paths, line numbers, dependency lists, return value descriptions. Produces a checklist of every verifiable claim found.

### 2. validate (auto gate)

- **Agent**: `scanner` (sonnet)
- **Rules**: `knowledge`
- **Reads**: `.ewh-artifacts/claims-checklist.md`
- **Context**: scan-docs (full)
- **Artifact**: `.ewh-artifacts/validation-results.md`
- **Requires**: claims checklist artifact exists

For each claim, verifies against current source code using Read, Grep, and Glob. Checks that function names exist, file paths are on disk, line references are approximately correct, dependency lists match manifests. Reports each claim as CONFIRMED or STALE/WRONG with evidence.

### 3. propose-fixes (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: `knowledge`
- **Reads**: `.ewh-artifacts/validation-results.md`
- **Context**: validate (full)
- **Requires**: validation results artifact exists

Presents all stale/wrong claims with evidence and proposes specific corrections. You must approve before any changes are made.

### 4. apply-fixes (auto gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `knowledge`, `coding`
- **Reads**: `.ewh-artifacts/validation-results.md`
- **Context**: propose-fixes (full)
- **Requires**: validation results artifact exists

Applies only the approved documentation corrections. Cites the source code that proves each correction.
