# Testing Project-Scope Overrides

Manual verification checklist for EWH's three resolution paths:
agent override, rule concatenation, and workflow override.

**Audience:**
- *EWH contributors* — run before merging changes to the dispatcher (`skills/doit/SKILL.md`)
- *Project owners* — run to confirm your `.claude/` overrides are picked up correctly

**Verification signals:**
- **Assembled prompt** — the full text passed to the Agent tool, visible in Claude Code's turn output. Agent template content opens the prompt; rules appear under `## Active Rules`.
- **Dispatcher log** — messages Claude emits before spawning an agent (e.g., "Skipping rule: not found").

---

## Fixture Setup

```bash
mkdir /tmp/ewh-test && cd /tmp/ewh-test
git init
printf "# Test project\n\n## Harness Config\n- Language: none\n- Test command: none\n" > CLAUDE.md
claude --plugin-dir /path/to/easy-workflow-harness
```

Each check below includes a **Setup** script that creates its fixture files (removing leftovers from the previous check) and a **Cleanup** script to remove them after.

---

## Check 1 — Project agent replaces plugin agent

**Setup**

```bash
mkdir -p .claude/agents .claude/workflows

cat > .claude/agents/coder.md << 'EOF'
---
name: coder
description: "Test override"
model: sonnet
tools: [Read]
maxTurns: 3
---
## PROJECT-OVERRIDE-MARKER
This is the project-scoped coder agent.
Emit AGENT_COMPLETE when done.
EOF

cat > .claude/workflows/test-override.md << 'EOF'
---
name: test-override
description: "Fixture workflow for override testing"
---
## Steps
- name: run-coder
  agent: coder
  gate: structural
  rules: []
  description: "Print hello world."
EOF
```

**Run**

```bash
/ewh:doit test-override "hello"
```

Stop at the structural gate before the agent spawns.

**Pass:** `PROJECT-OVERRIDE-MARKER` present in assembled prompt; plugin coder role description absent.

**Fail:** Plugin content appears instead — dispatcher resolved wrong file.

**Cleanup**

```bash
rm .claude/agents/coder.md .claude/workflows/test-override.md
```

---

## Check 2 — Project agent extends plugin agent

**Setup** (removes Check 1 fixtures)

```bash
rm -f .claude/agents/coder.md
mkdir -p .claude/agents .claude/workflows

cat > .claude/agents/scanner.md << 'EOF'
---
name: scanner
description: "Test extension"
extends: ewh:scanner
model: sonnet
tools: [Read, Grep]
maxTurns: 3
---
## PROJECT-EXTENSION-MARKER
These are project-specific scanner instructions appended after the plugin template.
EOF

cat > .claude/workflows/test-override.md << 'EOF'
---
name: test-override
description: "Fixture workflow for override testing"
---
## Steps
- name: run-scanner
  agent: scanner
  gate: structural
  rules: []
  description: "Scan for issues."
EOF
```

**Run**

```bash
/ewh:doit test-override "scan for issues"
```

Stop at the structural gate.

**Pass:** Plugin scanner content present; `PROJECT-EXTENSION-MARKER` appears after it.

**Fail signals:**
- `PROJECT-EXTENSION-MARKER` absent → extension not concatenated
- Plugin content absent → treated as full override instead of extension
- Marker appears before plugin content → wrong concatenation order

**Cleanup**

```bash
rm .claude/agents/scanner.md .claude/workflows/test-override.md
```

---

## Check 3 — Plugin rule and project rule both injected

**Setup** (removes Check 2 fixtures)

```bash
rm -f .claude/agents/scanner.md
mkdir -p .claude/rules .claude/workflows

cat > .claude/rules/no-mutations.md << 'EOF'
---
name: no-mutations
description: "Test project rule"
scope: step
severity: low
inject_into: coder
---
## PROJECT-RULE-MARKER
Do not mutate any existing files during this step.
EOF

cat > .claude/workflows/test-override.md << 'EOF'
---
name: test-override
description: "Fixture workflow for override testing"
---
## Steps
- name: run-coder
  agent: coder
  gate: structural
  rules: [no-mutations]
  description: "Print hello world."
EOF
```

> **Note:** This check verifies concatenation of a plugin rule with a project rule. If the plugin does not ship a `rules/no-mutations.md`, create one temporarily in the plugin's `rules/` directory before running.

**Run**

```bash
/ewh:doit test-override "hello"
```

Stop at the structural gate.

**Pass:** `## Active Rules` contains plugin rule body followed by `### Project-Specific (.claude/rules/no-mutations.md)` section containing `PROJECT-RULE-MARKER`.

**Fail signals:**
- Only one source present → concatenation not happening
- `### Project-Specific` header absent → project rule injected without attribution
- Project rule appears before plugin rule → wrong merge order

**Cleanup**

```bash
rm .claude/rules/no-mutations.md .claude/workflows/test-override.md
```

---

## Check 4 — Rule found in `.claude/rules/` subdirectory

**Setup** (removes Check 3 fixtures)

```bash
rm -f .claude/rules/no-mutations.md
mkdir -p .claude/rules/ewh .claude/workflows

cat > .claude/rules/ewh/no-mutations.md << 'EOF'
---
name: no-mutations
description: "Test subdirectory rule"
scope: step
severity: low
inject_into: coder
---
## SUBDIR-RULE-MARKER
Subdirectory-scoped version of the no-mutations rule.
EOF

cat > .claude/workflows/test-override.md << 'EOF'
---
name: test-override
description: "Fixture workflow for override testing"
---
## Steps
- name: run-coder
  agent: coder
  gate: structural
  rules: [no-mutations]
  description: "Print hello world."
EOF
```

**Run**

```bash
/ewh:doit test-override "hello"
```

Stop at the structural gate.

**Pass:** `### Project-Specific (.claude/rules/ewh/no-mutations.md)` present in `## Active Rules` containing `SUBDIR-RULE-MARKER`.

**Fail:** Section absent — dispatcher glob did not recurse into subdirectories.

**Cleanup**

```bash
rm .claude/rules/ewh/no-mutations.md .claude/workflows/test-override.md
rmdir .claude/rules/ewh 2>/dev/null || true
```

---

## Check 5 — Multiple project-side files with the same basename all applied

**Setup** (removes Check 4 fixtures, recreates both rule files)

```bash
rm -f .claude/workflows/test-override.md
mkdir -p .claude/rules/ewh .claude/workflows

cat > .claude/rules/ewh/no-mutations.md << 'EOF'
---
name: no-mutations
description: "Test subdirectory rule"
scope: step
severity: low
inject_into: coder
---
## SUBDIR-RULE-MARKER
Subdirectory-scoped version of the no-mutations rule.
EOF

cat > .claude/rules/no-mutations.md << 'EOF'
---
name: no-mutations
description: "Test project rule"
scope: step
severity: low
inject_into: coder
---
## PROJECT-RULE-MARKER
Do not mutate any existing files during this step.
EOF

cat > .claude/workflows/test-override.md << 'EOF'
---
name: test-override
description: "Fixture workflow for override testing"
---
## Steps
- name: run-coder
  agent: coder
  gate: structural
  rules: [no-mutations]
  description: "Print hello world."
EOF
```

**Run**

```bash
/ewh:doit test-override "hello"
```

Stop at the structural gate.

**Pass:** Both sections present in `## Active Rules`:
- `### Project-Specific (.claude/rules/ewh/no-mutations.md)` with `SUBDIR-RULE-MARKER`
- `### Project-Specific (.claude/rules/no-mutations.md)` with `PROJECT-RULE-MARKER`

Sections appear in lex-sorted path order (`.claude/rules/ewh/` before `.claude/rules/`).

**Fail signals:**
- Only one section present → dispatcher deduplicated or stopped at first match
- Both present but out of order → lex sort not applied

**Cleanup**

```bash
rm .claude/rules/no-mutations.md .claude/rules/ewh/no-mutations.md .claude/workflows/test-override.md
rmdir .claude/rules/ewh 2>/dev/null || true
```

---

## Check 6 — Project workflow replaces plugin workflow

**Setup** (removes Check 5 fixtures)

```bash
rm -f .claude/rules/no-mutations.md .claude/rules/ewh/no-mutations.md .claude/workflows/test-override.md
rmdir .claude/rules/ewh 2>/dev/null || true
mkdir -p .claude/workflows

cat > .claude/workflows/add-feature.md << 'EOF'
---
name: add-feature
description: "PROJECT-WORKFLOW-OVERRIDE"
---
## Steps
- name: project-only-step
  agent: coder
  gate: structural
  rules: []
  description: "Project override step — if you see this, the override is working."
EOF
```

**Run**

```bash
/ewh:doit add-feature "test"
```

**Pass:** Workflow plan shows description `PROJECT-WORKFLOW-OVERRIDE` and step `project-only-step` only. Plugin steps (`explore`, `implement`, `review`, etc.) are absent.

**Fail:** Plugin step names appear — dispatcher resolved plugin workflow instead of project override.

**Cleanup**

```bash
rm .claude/workflows/add-feature.md
```
