# Workflow: create-rules

> Source: [`workflows/create-rules.md`](../workflows/create-rules.md)

Design and scaffold a project-specific rule file in `.claude/rules/`.

## When to Use

When you need a custom rule for your project — coding standards, review criteria, or compliance checks that go beyond the built-in rules. The workflow guides you through designing the rule and scaffolds it in the correct format.

```bash
/ewh:doit create-rules "add a rule for SQL query safety"
```

## Steps

### 1. plan (structural gate)

- **Agent**: none (plan mode / brainstorming)
- **Rules**: none
- **Artifact**: `.ewh-artifacts/plan.md`

Enter plan mode to design the rule. Scans existing rules in `rules/` and `.claude/rules/` for format patterns and shows them as examples. Gathers your requirements: rule name, description, scope, severity, `inject_into` targets, and verify command.

### 2. propose (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: none
- **Reads**: `.ewh-artifacts/plan.md`
- **Context**: plan (full)
- **Artifact**: `.ewh-artifacts/proposed-rule.md`
- **Requires**: plan artifact exists

Drafts the complete rule file with proper frontmatter (`name`, `description`, `scope`, `severity`, `inject_into`, `verify`) and rule body sections. Suggests improvements: verify commands for automated checking, severity tuning, scope coverage. You approve the final content.

### 3. create (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `coding`
- **Reads**: `.ewh-artifacts/proposed-rule.md`
- **Context**: propose (full)
- **Requires**: proposed rule artifact exists

Writes the approved rule file to `.claude/rules/<name>.md` exactly as proposed. Creates the directory if needed.

### 4. review (auto gate)

- **Agent**: `reviewer` (sonnet)
- **Rules**: `review`
- **Context**: create (full)
- **Requires**: create step modified files

Verifies the created rule follows EWH conventions: frontmatter has all required fields, sections are clear and actionable, rule is specific enough to be enforceable, verify command is valid shell syntax.
