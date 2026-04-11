---
name: coding
description: Standards for how Claude writes and modifies code
scope: [code-changes]
severity: default
inject_into: [coder]
verify: null
---

## Principles

- Edit existing files over creating new ones
- Do exactly what was asked — no bonus features, no speculative abstractions
- No comments, docstrings, or type annotations on code you didn't change
- Three similar lines beats a premature abstraction

## Changes

- Read code before modifying it — never speculate about code you haven't opened
- Minimal diff — only touch what the task requires
- No dead code, no commented-out blocks, no backwards-compat shims
- No error handling for scenarios that can't happen
- Trust internal code and framework guarantees; validate only at system boundaries

## Naming & Structure

- Follow the project's existing naming conventions (detected from CLAUDE.md or codebase)
- New functions/files follow existing patterns in the project
- One responsibility per function

## Security

- No command injection, XSS, SQL injection, or OWASP top 10 vulnerabilities
- Never hardcode secrets or credentials
- If you notice insecure code you wrote, fix it immediately

## After Changes

- Run the project's test command (from Harness Config)
- Report: files changed, lines added/removed, tests passing/failing
