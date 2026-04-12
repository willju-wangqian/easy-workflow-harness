# Workflow: add-feature

> Source: [`workflows/add-feature.md`](../workflows/add-feature.md)

Plan, implement, review, and test a new feature from scratch.

## When to Use

When you need to build something new — a feature, a component, a module. This is the primary development workflow.

```bash
/ewh:doit add-feature "add CSV export to the reports page"
```

## Steps

### 1. plan (structural gate)

- **Agent**: none (plan mode / brainstorming)
- **Rules**: none
- **Artifact**: `.ewh-artifacts/plan.md`

You design the feature interactively. If the brainstorming skill is available, it provides structured design facilitation (understanding lock, decision log, alternatives). Otherwise, Claude's built-in plan mode is used.

The plan should include: files to create/modify, approach, key decisions, and acceptance criteria.

### 2. code (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `coding`
- **Reads**: `.ewh-artifacts/plan.md`
- **Context**: plan (full)
- **Requires**: plan artifact exists

The coder agent reads the plan and implements the changes. Follows coding rules (minimal diffs, no speculative abstractions, security basics). Runs tests after changes.

### 3. review (auto gate)

- **Agent**: `reviewer` (sonnet)
- **Rules**: `review`
- **Context**: code (full)
- **Requires**: code step modified files

The reviewer reads all modified files and checks for bugs, logic errors, rule violations, and security issues. Reports findings with severity ratings (critical/warning/nit). Cannot edit code — report only.

### 4. test (auto gate)

- **Agent**: `tester` (sonnet)
- **Rules**: `testing`
- **Context**: code (full), review (summary)
- **Requires**: code step modified files

The tester writes tests for the new feature covering happy path, error cases, and edge cases. Runs the full test suite and reports results.
