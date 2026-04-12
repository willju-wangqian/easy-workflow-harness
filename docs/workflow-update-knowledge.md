# Workflow: update-knowledge

> Source: [`workflows/update-knowledge.md`](../workflows/update-knowledge.md)

Update CLAUDE.md and project documentation to reflect current project state.

## When to Use

After making significant changes to a project — new features, architecture changes, dependency updates — when the documentation needs to catch up. Unlike `check-fact` (which validates existing claims), this workflow proactively identifies what's missing or outdated.

```bash
/ewh:doit update-knowledge "sync docs after the auth refactor"
```

## Steps

### 1. read-governance (auto gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: `knowledge`

The dispatcher reads the project's maintenance rules or governance docs directly. Identifies which files are maintained, what triggers updates, and what the update scope is. Falls back to the knowledge rule defaults if no governance docs exist.

### 2. inspect-state (auto gate)

- **Agent**: `scanner` (sonnet)
- **Rules**: `knowledge`
- **Context**: read-governance (summary)
- **Artifact**: `.ewh-artifacts/inspection-results.md`

Inspects current project state against maintained documentation:
- Compares CLAUDE.md architecture/commands/conventions against source
- Checks memory files against git log and test results
- Checks spec files for stale references
- Runs git log to identify recent changes not reflected in docs

Writes specific diffs of what needs updating.

### 3. apply-updates (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `knowledge`, `coding`
- **Reads**: `.ewh-artifacts/inspection-results.md`
- **Context**: inspect-state (full)
- **Requires**: inspection results artifact exists

Applies the proposed documentation updates. Presents changes before writing. Only updates what the inspect step identified as stale. Source code is the authority.
