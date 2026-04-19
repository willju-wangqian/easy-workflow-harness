---
name: trivial
description: "Smoke-test workflow for the v2 dispatcher binary (Phase 1). Runs two no-op steps so the state machine can be exercised end-to-end without spawning an agent."
trigger: "manual smoke test only"
---

# Trivial Workflow

Two no-op steps, each carrying a `message:`. The Phase-1 state machine
auto-completes any step with no `agent:`, so this workflow runs entirely
inside the binary — no agent dispatch, no gates. Safe to delete once
later phases land real smoke-test fixtures.

## Steps

- name: hello
  gate: auto
  message: Step one ran.

- name: goodbye
  gate: auto
  message: Step two ran.
