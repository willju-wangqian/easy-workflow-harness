#!/usr/bin/env bash
set -euo pipefail

EWH_DIR=$(cd "$(dirname "$0")/.." && pwd)
TEST_REPO=/tmp/ewh-test
JSONL_DIR="$HOME/.claude/projects/-private-tmp-ewh-test"

# --- One-time setup ---
rm -rf "$TEST_REPO"
mkdir -p "$TEST_REPO/.claude"
cd "$TEST_REPO"
git init -q
printf "# Test project\n\n## Harness Config\n- Language: none\n- Test command: none\n" > CLAUDE.md

# Pre-populate ewh-state.json to bypass the startup "Proceed?" gate for all test workflows.
# auto_approve_start in workflow frontmatter is not reliably honored by the LLM dispatcher.
cat > "$TEST_REPO/.claude/ewh-state.json" << 'EOF'
{
  "auto_approve_start": {
    "test-override": true,
    "add-feature": true
  }
}
EOF

pass=0; fail=0

# --- Shared runner ---
run_check() {
  local id=$1 label=$2 workflow=${3:-test-override} trigger=${4:-hello}

  rm -rf "$TEST_REPO/.ewh-artifacts"   # prevent stale-artifact gate
  cd "$TEST_REPO"

  # Use a deterministic session ID so we know exactly which .jsonl to read.
  local session_id
  session_id=$(python3 -c "import uuid; print(uuid.uuid4())")
  local jsonl="$JSONL_DIR/$session_id.jsonl"

  local err_file
  err_file=$(mktemp)

  claude --plugin-dir "$EWH_DIR" --dangerously-skip-permissions \
    --session-id "$session_id" \
    -p "/ewh:doit $workflow $trigger" > /dev/null 2>"$err_file" || true

  if [ ! -f "$jsonl" ]; then
    local err_msg
    err_msg=$(cat "$err_file" | head -3)
    rm -f "$err_file"
    printf "FAIL [%s] %s — no session file created\n" "$id" "$label"
    [ -n "$err_msg" ] && printf "  stderr: %s\n" "$err_msg"
    fail=$((fail+1)); return
  fi
  rm -f "$err_file"

  if python3 "$EWH_DIR/tests/parse_log.py" "$jsonl" "$id"; then
    printf "PASS [%s] %s\n" "$id" "$label"
    pass=$((pass+1))
  else
    printf "FAIL [%s] %s\n" "$id" "$label"
    # Print what the parser saw to aid debugging
    python3 "$EWH_DIR/tests/parse_log.py" "$jsonl" "$id" --debug 2>&1 | sed 's/^/  /' || true
    fail=$((fail+1))
  fi
}

# --- Check 1: Project agent replaces plugin agent ---
mkdir -p "$TEST_REPO/.claude/agents" "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/agents/coder.md" << 'EOF'
---
name: coder
description: "Test override"
model: sonnet
tools: [Read]
maxTurns: 3
---
## PROJECT-OVERRIDE-MARKER
Project-scoped coder override.
Emit AGENT_COMPLETE when done.
EOF

cat > "$TEST_REPO/.claude/workflows/test-override.md" << 'EOF'
---
name: test-override
description: "Fixture for override testing"
auto_approve_start: true
---
## Steps
- name: run-coder
  agent: coder
  gate: auto
  rules: []
  description: "Print hello world."
EOF

run_check 1 "Project agent replaces plugin agent"
rm "$TEST_REPO/.claude/agents/coder.md" "$TEST_REPO/.claude/workflows/test-override.md"

# --- Check 2: Project agent extends plugin agent ---
mkdir -p "$TEST_REPO/.claude/agents" "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/agents/scanner.md" << 'EOF'
---
name: scanner
description: "Test extension"
extends: ewh:scanner
model: sonnet
tools: [Read, Grep]
maxTurns: 3
---
## PROJECT-EXTENSION-MARKER
Project-specific scanner instructions.
EOF

cat > "$TEST_REPO/.claude/workflows/test-override.md" << 'EOF'
---
name: test-override
description: "Fixture for extension testing"
auto_approve_start: true
---
## Steps
- name: run-scanner
  agent: scanner
  gate: auto
  rules: []
  description: "Scan for issues."
EOF

run_check 2 "Project agent extends plugin agent"
rm "$TEST_REPO/.claude/agents/scanner.md" "$TEST_REPO/.claude/workflows/test-override.md"

# Shared coder fixture for checks 3-6 (agent resolution; these checks test rules/workflows, not agents)
cat > "$TEST_REPO/.claude/agents/coder.md" << 'EOF'
---
name: coder
description: "Fixture coder"
model: sonnet
tools: [Read]
maxTurns: 3
---
Do exactly what the task says. Emit AGENT_COMPLETE when done.
EOF

# --- Check 3: Plugin rule + project rule both injected ---
mkdir -p "$TEST_REPO/.claude/rules" "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/rules/coding.md" << 'EOF'
---
name: coding
description: "Test project rule"
scope: step
severity: low
inject_into: coder
---
## PROJECT-RULE-MARKER
Do not mutate any existing files during this step.
EOF

cat > "$TEST_REPO/.claude/workflows/test-override.md" << 'EOF'
---
name: test-override
description: "Fixture for rule concatenation testing"
auto_approve_start: true
---
## Steps
- name: run-coder
  agent: coder
  gate: auto
  rules: [coding]
  description: "Print hello world."
EOF

run_check 3 "Plugin rule and project rule both injected"
rm "$TEST_REPO/.claude/rules/coding.md" "$TEST_REPO/.claude/workflows/test-override.md"

# --- Check 4: Rule found in .claude/rules/ subdirectory ---
mkdir -p "$TEST_REPO/.claude/rules/ewh" "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/rules/ewh/coding.md" << 'EOF'
---
name: coding
description: "Test subdirectory rule"
scope: step
severity: low
inject_into: coder
---
## SUBDIR-RULE-MARKER
Subdirectory-scoped coding rule.
EOF

cat > "$TEST_REPO/.claude/workflows/test-override.md" << 'EOF'
---
name: test-override
description: "Fixture for subdirectory rule testing"
auto_approve_start: true
---
## Steps
- name: run-coder
  agent: coder
  gate: auto
  rules: [coding]
  description: "Print hello world."
EOF

run_check 4 "Rule found in .claude/rules/ subdirectory"
rm "$TEST_REPO/.claude/rules/ewh/coding.md" "$TEST_REPO/.claude/workflows/test-override.md"
rmdir "$TEST_REPO/.claude/rules/ewh" 2>/dev/null || true

# --- Check 5: Multiple project-side files with same basename all applied ---
mkdir -p "$TEST_REPO/.claude/rules/ewh" "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/rules/ewh/coding.md" << 'EOF'
---
name: coding
description: "Test subdirectory rule"
scope: step
severity: low
inject_into: coder
---
## SUBDIR-RULE-MARKER
Subdirectory-scoped coding rule.
EOF

cat > "$TEST_REPO/.claude/rules/coding.md" << 'EOF'
---
name: coding
description: "Test project rule"
scope: step
severity: low
inject_into: coder
---
## PROJECT-RULE-MARKER
Do not mutate any existing files during this step.
EOF

cat > "$TEST_REPO/.claude/workflows/test-override.md" << 'EOF'
---
name: test-override
description: "Fixture for multiple same-basename rule testing"
auto_approve_start: true
---
## Steps
- name: run-coder
  agent: coder
  gate: auto
  rules: [coding]
  description: "Print hello world."
EOF

run_check 5 "Multiple project-side files with same basename all applied"
rm "$TEST_REPO/.claude/rules/ewh/coding.md" "$TEST_REPO/.claude/rules/coding.md" \
   "$TEST_REPO/.claude/workflows/test-override.md"
rmdir "$TEST_REPO/.claude/rules/ewh" 2>/dev/null || true

# --- Check 6: Project workflow replaces plugin workflow ---
mkdir -p "$TEST_REPO/.claude/workflows"

cat > "$TEST_REPO/.claude/workflows/add-feature.md" << 'EOF'
---
name: add-feature
description: "PROJECT-WORKFLOW-OVERRIDE"
auto_approve_start: true
---
## Steps
- name: project-only-step
  agent: coder
  gate: auto
  rules: []
  description: "Project override step."
EOF

run_check 6 "Project workflow replaces plugin workflow" "add-feature" "test"
rm "$TEST_REPO/.claude/workflows/add-feature.md"
rm -f "$TEST_REPO/.claude/agents/coder.md"

# --- Summary ---
echo ""
printf "%d/6 passed\n" "$pass"
[ "$fail" -eq 0 ]
