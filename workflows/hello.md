---
name: hello
description: Smoke-test workflow — one agent step with an artifact
trigger: "/ewh:doit hello"
---

## Steps

- name: greet
  agent: hello
  gate: auto
  artifact: .ewh-artifacts/greeting.txt
  description: >
    Write "Hello, World!" to .ewh-artifacts/greeting.txt using the Write tool.
