# Easy Workflow Harness (EWH)

A Claude Code plugin that turns multi-step development tasks into repeatable, structured workflows. Instead of giving Claude a vague instruction like "add a feature," EWH breaks the work into discrete steps — plan, code, review, test — each handled by a specialized agent with the right tools, rules, and context.

## Why Use This?

When you ask Claude Code to do something complex, it often tries to do everything at once: write code, review it, write tests, and update docs — all in a single pass. The results are inconsistent. Sometimes it skips testing. Sometimes it reviews its own code and declares it perfect.

EWH fixes this by:

- **Separating concerns** — different agents handle coding, reviewing, and testing, so no agent reviews its own work
- **Enforcing standards** — rules are injected into agent prompts, so coding standards and review criteria are applied consistently
- **Providing guardrails** — gates pause the workflow at key decision points so you stay in control
- **Passing context selectively** — each agent receives only the information it needs, keeping prompts focused and effective

## Getting Started

### Install

Test locally by pointing Claude Code at this plugin:

```bash
claude --plugin-dir /path/to/easy-workflow-harness
```

### Your First Workflow

Open any project and run:

```bash
# 1. Bootstrap your project (auto-detects language, test commands, conventions)
/ewh:doit init

# 2. Build a feature
/ewh:doit add-feature "add CSV export to the reports page"
```

The dispatcher walks you through each step, pausing at **gates** where your input is needed. You'll see a plan of what's about to happen and can approve, modify, or abort at any point.

### Available Commands

```bash
/ewh:doit <name> [description]    # run a workflow
/ewh:doit list                    # list all available workflows
/ewh:doit init                    # bootstrap project for EWH
```

## Workflows

A workflow is a sequence of steps. Each step runs an agent (or a skill, or a direct command) with specific rules and context. EWH ships with six built-in workflows:

| Workflow | What it does | Steps |
|---|---|---|
| `init` | Bootstrap a project for EWH — detects language, test framework, and conventions, then appends a Harness Config section to your CLAUDE.md | scan, propose, apply |
| `add-feature` | Design and implement a new feature from scratch | plan, code, review, test |
| `refine-feature` | Improve existing code — scan for issues, propose fixes, implement approved changes | scan, propose, code, review, test |
| `fact-check` | Verify that documentation (README, CLAUDE.md, specs) matches actual source code | scan-docs, validate, propose-fixes, apply-fixes |
| `knowledge-update` | Update CLAUDE.md and project docs to reflect current project state | read-governance, inspect-state, apply-updates |
| `clean-up` | Full repo health check — run tests, linter, doc build, then update docs | test, check, build-docs, knowledge-update |

## Agents

Agents are specialized roles with distinct capabilities. Each agent has its own model, tool set, and behavioral instructions. Importantly, agents are scoped — a reviewer can read code but can't edit it, so it can't silently "fix" issues instead of reporting them.

| Agent | Model | Tools | Role |
|---|---|---|---|
| `coder` | sonnet | Read, Write, Edit, Bash, Glob, Grep | Implements changes, runs tests, follows coding rules |
| `reviewer` | sonnet | Read, Glob, Grep, Bash | Reviews code changes for bugs, quality, and rule compliance (read-only) |
| `scanner` | sonnet | Read, Glob, Grep, Bash | Scans existing code and docs for issues, stale claims, or improvements (read-only) |
| `tester` | sonnet | Read, Write, Edit, Bash, Glob, Grep | Writes tests, runs the full suite, reports bugs (does not fix source code) |
| `compliance` | haiku | Read, Glob, Grep, Bash | Lightweight auditor that verifies critical rules were followed after a step |

### How Agents Receive Context

Each agent's prompt is assembled by the dispatcher in a specific order:

1. **Agent template** — the agent's role, behavior rules, and output format
2. **Required Reading** — specific files the agent must read (from `reads:` in the workflow step)
3. **Active Rules** — the full text of rules listed in the step's `rules:` array
4. **Prior Steps** — summaries from earlier steps, filtered by the step's `context:` field
5. **Task** — the user's request plus the step description from the workflow
6. **Project Context** — applicable Harness Config values (test command, source patterns, etc.)

The project's CLAUDE.md is **not** included in this prompt — the Claude Code runtime automatically injects it into every subagent, so the dispatcher doesn't duplicate it.

### Self-Gating

Every agent has a "Before You Start" checklist. If an agent doesn't have enough context to do its job (e.g., a reviewer with no files to review), it reports what's missing and exits cleanly instead of guessing.

## Rules

Rules define standards that agents must follow. They're injected as prose into agent prompts — the agent reads them as instructions, not as code.

| Rule | What it enforces |
|---|---|
| `coding` | Minimal diffs, no dead code, no speculative abstractions, security basics, run tests after changes |
| `review` | Readability, performance, best practices, security — with severity ratings (critical/warning/nit) |
| `testing` | Test contracts not implementations, cover edge cases, run the full suite |
| `knowledge` | Source code is the authority, keep docs concise, no stale references |

Rules have a `severity` field. Rules marked `severity: critical` with a `verify` command trigger an automatic **compliance check** after the step completes — a lightweight haiku-based auditor runs the verification and reports pass/fail.

## Gates

Gates control where the workflow pauses for your input:

- **structural** — the workflow stops and shows you what's about to happen. You must confirm before it proceeds. Used for decisions that matter (approving a plan, reviewing proposed changes).
- **auto** — the workflow proceeds silently. Used for mechanical steps where human review isn't needed (running tests, automated scanning).
- **compliance** — triggered automatically when a step has critical rules with `verify` commands. If verification fails, the workflow always stops, regardless of the step's gate type. You can choose to fix, override, or abort.

You're never locked in — at any gate, you can abort the workflow. Completed work is preserved as-is.

## How It Works

Here's what happens when you run `/ewh:doit add-feature "add CSV export"`:

```
/ewh:doit add-feature "add CSV export"
         |
         v
   +-------------+
   |  Dispatcher  |  reads workflow definition, presents plan
   +------+------+
          |
   Step 1: plan (gate: structural)
          |  You design the feature (brainstorming or plan mode)
          |  Output: .claude/artifacts/plan.md
          v
   Step 2: code (gate: structural)
          |  Coder agent reads plan, implements changes, runs tests
          |  Rules: coding
          v
   Step 3: review (gate: auto)
          |  Reviewer agent checks code for bugs and rule compliance
          |  Rules: review
          v
   Step 4: test (gate: auto)
          |  Tester agent writes tests, runs full suite
          |  Rules: testing
          v
   Workflow complete -- summary of all steps
```

### Artifact Handoff

Steps can produce **artifacts** — files written to `.claude/artifacts/` that downstream steps consume. For example, the plan step writes a plan file, and the code step reads it via `reads:`. This keeps each agent focused on its own job while maintaining a clear chain of information.

### Partial Output Recovery

If an agent's output is cut off (no `AGENT_COMPLETE` sentinel detected), the dispatcher automatically:
1. Spawns a continuation agent to finish the remaining work
2. If that also fails, splits the work into parallel chunks of 30 items each
3. Merges chunk results into a unified report

You don't need to manage this — it happens transparently.

## Customizing EWH for Your Project

EWH works at three levels of customization:

### Level 1: Zero Config

Just run `/ewh:doit <workflow>` in any project. The dispatcher asks for missing values (test command, source patterns) as it needs them.

### Level 2: Init'd

Run `/ewh:doit init` once. It scans your project and adds a `## Harness Config` section to your CLAUDE.md:

```markdown
## Harness Config

- Language: Python
- Test command: pytest
- Check command: ruff check .
- Source pattern: src/**/*.py
- Test pattern: tests/test_*.py
- Doc build: mkdocs build
- Conventions: PEP 8, type hints, Google-style docstrings
```

This is what agents receive under `## Project Context` — they use it to run tests, find source files, and follow your conventions.

### Level 3: Custom Overrides

Add project-specific overrides in your `.claude/` directory:

| What | Where | How it merges |
|---|---|---|
| Agents | `.claude/agents/<name>.md` | Replaces the plugin agent, or extends it |
| Rules | `.claude/rules/<name>.md` | Concatenated with the plugin rule (both apply) |
| Workflows | `.claude/workflows/<name>.md` | Replaces the plugin workflow entirely |

#### Extend an Agent

If you want to keep the built-in agent behavior but add project-specific instructions:

```markdown
<!-- .claude/agents/coder.md -->
---
extends: ewh:coder
---

## Project-Specific

- Use our internal logging library, not print statements
- All new endpoints need OpenAPI annotations
- Run `make lint` after changes
```

#### Supplement a Rule

Project rules are appended to the plugin rule, so both apply:

```markdown
<!-- .claude/rules/coding.md -->
## Project-Specific

- Use `logger.error()` not `raise Exception()`
- All SQL queries must use parameterized statements
- New files go in `src/app/` not project root
```

#### Replace a Workflow

Create `.claude/workflows/add-feature.md` with your own step definitions. It completely replaces the plugin's version. See [Creating Your Own Workflow](#creating-your-own-workflow) for the format.

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

## Recommended: Brainstorming Skill

The `add-feature` workflow's plan step works best with a dedicated brainstorming skill that provides structured design facilitation — understanding lock, decision log, alternatives exploration. Without it, the step falls back to Claude's built-in plan mode, which still works but provides less structure.

## License

MIT
