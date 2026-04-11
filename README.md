# Easy Workflow Harness (EWH)

Opinionated workflow orchestration for Claude Code. Rules, agents, workflows, and a dispatcher that ties them together.

## Install

```bash
# Add marketplace (if not already added)
/plugin marketplace add <marketplace-source>

# Install the plugin
/plugin install easy-workflow-harness
```

Or test locally:

```bash
claude --plugin-dir /path/to/easy-workflow-harness
```

## Quickstart

```bash
cd your-project

# 1. Bootstrap your project (detects language, test commands, conventions)
/ewh:doit init

# 2. Run a workflow
/ewh:doit add-feature "add CSV export to the reports page"
```

That's it. The dispatcher walks you through plan → code → review → test with gates at key decision points.

## What's in the Box

### Workflows

| Workflow | Steps | What it does |
|---|---|---|
| `init` | scan → propose → apply | Bootstrap a project for EWH |
| `add-feature` | plan → code → review → test | Design and implement a new feature |
| `refine-feature` | scan → propose → code → review → test | Improve existing code |
| `fact-check` | scan-docs → validate → propose → apply | Verify docs match source code |
| `knowledge-update` | read-governance → inspect → apply | Update CLAUDE.md and memory files |
| `clean-up` | test → check → build-docs → knowledge-update | Full repo health check |


### Rules

| Rule | Injected into | What it enforces |
|---|---|---|
| `coding` | coder | Minimal diffs, no dead code, security, run tests |
| `testing` | tester | Test contracts not implementations, edge cases, full suite |
| `review` | reviewer | Readability, performance, best practices, security |
| `knowledge` | coder, reviewer | Source of truth, doc accuracy, no stale references |

### Agents

| Agent | Model | Role |
|---|---|---|
| `coder` | sonnet | Implements changes, runs tests, follows rules |
| `reviewer` | sonnet | Read-only code review with severity ratings |
| `tester` | sonnet | Writes tests, runs suite, reports bugs |
| `compliance` | haiku | Lightweight auditor for critical rules |

## How It Works

```
/ewh:doit add-feature "add CSV export"
         │
         ▼
   ┌─────────────┐
   │  Dispatcher  │  reads workflow definition
   └──────┬──────┘
          │
    ┌─────┴─────┐
    ▼           ▼
  Step 1     Step 2 ...
    │           │
    ├─ load rules (plugin + project supplements)
    ├─ resolve agent (project override → plugin default)
    ├─ build prompt (agent + rules + prior steps + task)
    ├─ spawn agent
    ├─ collect result (compressed summary)
    └─ compliance check (if critical rules exist)
```

**Gates** control the pace:
- **structural** — pauses for user confirmation before proceeding
- **auto** — proceeds silently
- **compliance** — auto-triggered when critical rules have `verify` fields; failures always gate

## Customize

EWH works at three levels:

### 1. Zero Config

Just run `/ewh:doit <workflow>`. The dispatcher asks for missing values inline.

### 2. Init'd

Run `/ewh:doit init` to add a `## Harness Config` section to your project's `CLAUDE.md`:

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

### 3. Customized

Add project-level overrides in `.claude/`:

| Override | Location | Behavior |
|---|---|---|
| **Agents** | `.claude/agents/<name>.md` | Replaces or extends plugin agent |
| **Rules** | `.claude/rules/<name>.md` | Concatenated with plugin rule |
| **Workflows** | `.claude/workflows/<name>.md` | Replaces plugin workflow entirely |

#### Extend an agent

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

#### Supplement a rule

```markdown
<!-- .claude/rules/coding.md -->
## Project-Specific

- Use `logger.error()` not `raise Exception()`
- All SQL queries must use parameterized statements
- New files go in `src/app/` not project root
```

#### Replace a workflow

Create `.claude/workflows/add-feature.md` with your own step definitions. It completely replaces the plugin's version.

## Create Your Own Workflow

Add a file to `.claude/workflows/` or contribute to the plugin:

```yaml
---
name: my-workflow
description: What this workflow does
trigger: "/ewh:doit my-workflow"
---

## Steps

- name: step-one
  agent: reviewer        # or null for direct execution
  gate: structural       # structural | auto
  rules: [coding]        # rules to inject
  description: >
    What this step does.
    The agent receives this as part of its task prompt.

- name: step-two
  agent: coder
  gate: auto
  rules: [coding, testing]
  description: >
    Next step. Receives compressed summary from step-one
    under ## Prior Steps in its prompt.
```

## Create Your Own Rule

Add a file to `.claude/rules/` (project supplement) or contribute to the plugin:

```yaml
---
name: my-rule
description: What this rule enforces
scope: [when-it-applies]
severity: default        # default | critical
inject_into: [coder]    # which agents receive this rule
verify: null             # shell command for compliance check (critical rules only)
---

## Section Name

- Bullet points describing the standard
- These are injected verbatim into agent prompts
```

Rules with `severity: critical` and a `verify` field trigger automatic compliance checks after each step.

## Recommended: Brainstorming Skill

The `add-feature` workflow's plan step works best with a dedicated brainstorming skill that provides structured design facilitation — understanding lock, decision log, alternatives exploration. Without it, the step falls back to Claude's built-in plan mode, which still works but is less structured.

## Commands Reference

```bash
/ewh:doit <name> [description]    # run a workflow
/ewh:doit list                    # list all available workflows
/ewh:doit init                    # bootstrap project CLAUDE.md
```

## License

MIT
