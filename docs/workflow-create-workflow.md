# Workflow: create-workflow

> Source: [`workflows/create-workflow.md`](../workflows/create-workflow.md)

Design and scaffold a project-specific workflow file in `.claude/workflows/`.

## When to Use

When you need a custom workflow for your project — a sequence of steps tailored to your development process that the built-in workflows don't cover. The workflow guides you through designing the step chain and scaffolds it in the correct format.

```bash
/ewh:doit create-workflow "add a deploy workflow for staging"
```

## Steps

### 1. plan (structural gate)

- **Agent**: none (plan mode / brainstorming)
- **Rules**: none
- **Artifact**: `.ewh-artifacts/plan.md`

Enter plan mode to design the workflow. Scans existing workflows in `workflows/` and `.claude/workflows/` for format patterns and shows them as examples. Gathers your requirements: workflow name, description, trigger, and step definitions (name, agent, gate, rules, artifact, reads, requires, context for each step).

### 2. propose (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: none
- **Reads**: `.ewh-artifacts/plan.md`
- **Context**: plan (full)
- **Artifact**: `.ewh-artifacts/proposed-workflow.md`
- **Requires**: plan artifact exists

Drafts the complete workflow file with proper frontmatter (`name`, `description`, `trigger`) and a Steps section with all steps fully defined. Suggests improvements: artifact handoff between steps via `reads:`/`artifact:`, context flow declarations, gate type selection (structural vs auto), missing preconditions, rule assignments.

### 3. create (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `coding`
- **Reads**: `.ewh-artifacts/proposed-workflow.md`
- **Context**: propose (full)
- **Requires**: proposed workflow artifact exists

Writes the approved workflow file to `.claude/workflows/<name>.md` exactly as proposed. Creates the directory if needed.

### 4. review (auto gate)

- **Agent**: `reviewer` (sonnet)
- **Rules**: `review`
- **Context**: create (full)
- **Requires**: create step modified files

Verifies the created workflow follows EWH conventions: frontmatter complete, steps well-formed with all required fields, artifact/reads/context chain is coherent (no dangling references), agents referenced exist or are null, gate types appropriate, preconditions make sense.
