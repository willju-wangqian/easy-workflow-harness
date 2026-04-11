# Extending EWH

How to create project-specific workflows, agents, and rules for your project.

> Examples below are for demonstration purposes — adapt names, fields, and descriptions to your project.

## Creating Your Own Workflow

Add a Markdown file to `.claude/workflows/` (project-level) or contribute to the plugin's `workflows/` directory:

```yaml
---
name: my-workflow
description: What this workflow does
trigger: "/ewh:doit my-workflow"
---

## Steps

- name: analyze
  agent: scanner          # which agent runs this step
  gate: auto              # auto or structural
  rules: [review]         # rules injected into the agent's prompt
  context: []             # which prior steps to include (none for first step)
  description: >
    Scan the codebase for issues in the target area.

- name: fix
  agent: coder
  gate: structural
  rules: [coding]
  context:                # receive the analyze step's output
    - step: analyze
      detail: full        # full = 5-10 bullets with decisions and file detail
  requires:               # skip this step if precondition fails
    - prior_step: analyze
      has: findings
  description: >
    Fix the issues found in the analyze step.
```

### Step Fields Reference

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique name for the step |
| `agent` | Yes | Agent to run (`coder`, `reviewer`, `scanner`, `tester`, or `null` for direct execution) |
| `gate` | Yes | `structural` (pause for confirmation) or `auto` (proceed silently) |
| `rules` | Yes | List of rule names to inject into the agent's prompt |
| `description` | Yes | What the step does — becomes part of the agent's task prompt |
| `context` | No | Which prior steps to include and at what detail level (`raw`, `full`, or `summary`) |
| `artifact` | No | File path (under `.claude/artifacts/`) for the step's primary output |
| `reads` | No | List of files the agent must read before starting (typically artifacts from prior steps) |
| `requires` | No | Preconditions that must be met or the step is skipped |

### Context Detail Levels

When a step declares which prior steps it needs via `context:`, it also chooses a compression level:

- **`raw`** — full uncompressed agent output (use sparingly — can be very long)
- **`full`** — 5-10 bullets covering key decisions, file-level changes, approach taken, issues encountered
- **`summary`** — 1-3 bullets plus a file list (most compact)

Steps not listed in `context:` are excluded entirely. This keeps agent prompts focused — a tester doesn't need the full planning discussion, just a summary of what was coded and any reviewer warnings.

## Creating Your Own Rule

```yaml
---
name: my-rule
description: What this rule enforces
scope: [when-it-applies]
severity: default          # default or critical
inject_into: [coder]      # advisory — indicates intended audience
verify: null               # shell command for compliance check (critical only)
---

## Section Name

- Standards described as bullet points
- These are injected verbatim into agent prompts
- Be specific — agents follow these as instructions
```

Set `severity: critical` and provide a `verify` command to trigger automatic compliance checks after each step that uses this rule.

Note: The `inject_into` field is advisory metadata — it tells workflow authors which agents the rule is designed for, but the dispatcher doesn't enforce it. The step's `rules:` list is what actually controls injection.

## Creating Your Own Agent

```yaml
---
name: my-agent
description: What this agent does
model: sonnet              # sonnet or haiku
tools: [Read, Write, Edit, Bash, Glob, Grep]
maxTurns: 30
---

## Role

One-line description of what this agent does.

## Inputs

You will receive:
- A task description from the workflow step
- Injected rules (appear under ## Active Rules)
- Harness Config values (appear under ## Project Context)

## Before You Start

Verify you have sufficient context:
- [ ] Concrete task with enough detail to act on
- [ ] File paths or references to work with

If ANY item is missing: report what is missing and emit AGENT_COMPLETE.

## Behavior

- What the agent should do
- What it should NOT do

## Output Format

- Structured summary of results

At the very end of your response, after all other output, emit exactly:
AGENT_COMPLETE
```

Key requirements:
- The **Before You Start** section is mandatory — it prevents agents from guessing when context is missing
- The **AGENT_COMPLETE** sentinel must be the last line — the dispatcher uses it to detect partial output

## Internals

### Artifact Handoff

Steps can produce **artifacts** — files written to `.claude/artifacts/` that downstream steps consume. For example, the plan step writes a plan file, and the code step reads it via `reads:`. This keeps each agent focused on its own job while maintaining a clear chain of information.

### Partial Output Recovery

If an agent's output is cut off (no `AGENT_COMPLETE` sentinel detected), the dispatcher automatically:
1. Spawns a continuation agent to finish the remaining work
2. If that also fails, splits the work into parallel chunks of 30 items each
3. Merges chunk results into a unified report

You don't need to manage this — it happens transparently.
