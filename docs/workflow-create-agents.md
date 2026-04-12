# Workflow: create-agents

> Source: [`workflows/create-agents.md`](../workflows/create-agents.md)

Design and scaffold a project-specific agent file in `.claude/agents/`.

## When to Use

When you need a specialized agent for your project — a role with specific tools, behavior constraints, and output format that the built-in agents don't cover. The workflow ensures the agent follows EWH conventions (sentinel, self-gating, structured output).

```bash
/ewh:doit create-agents "add a deployment agent for our CI pipeline"
```

## Steps

### 1. plan (structural gate)

- **Agent**: none (plan mode / brainstorming)
- **Rules**: none
- **Artifact**: `.ewh-artifacts/plan.md`

Enter plan mode to design the agent. Scans existing agents in `agents/` and `.claude/agents/` for format patterns and shows them as examples. Gathers your requirements: agent name, description, model, tools, maxTurns, role description, and behavior constraints.

### 2. propose (structural gate)

- **Agent**: none (dispatcher handles directly)
- **Rules**: none
- **Reads**: `.ewh-artifacts/plan.md`
- **Context**: plan (full)
- **Artifact**: `.ewh-artifacts/proposed-agent.md`
- **Requires**: plan artifact exists

Drafts the complete agent file with proper frontmatter (`name`, `description`, `model`, `tools`, `maxTurns`) and all required sections: Role, Inputs, Before You Start (self-gating checklist), Behavior, Output Format, and the `AGENT_COMPLETE` sentinel instruction. Suggests improvements: tool selection, maxTurns tuning, self-gating conditions.

### 3. create (structural gate)

- **Agent**: `coder` (sonnet)
- **Rules**: `coding`
- **Reads**: `.ewh-artifacts/proposed-agent.md`
- **Context**: propose (full)
- **Requires**: proposed agent artifact exists

Writes the approved agent file to `.claude/agents/<name>.md` exactly as proposed. Creates the directory if needed. Ensures the `AGENT_COMPLETE` sentinel is present.

### 4. review (auto gate)

- **Agent**: `reviewer` (sonnet)
- **Rules**: `review`
- **Context**: create (full)
- **Requires**: create step modified files

Verifies the created agent follows EWH conventions: frontmatter complete, Before You Start section with self-gating checklist, Output Format section defined, `AGENT_COMPLETE` sentinel present as the last output instruction, role and behavior are clear.
