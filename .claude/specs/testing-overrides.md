---
name: testing-overrides
type: decision
status: accepted
scope: [testing, dispatcher, overrides]
created: 2026-04-12
---

## Understanding Summary

- **What:** A manual verification checklist (`docs/testing-overrides.md`) covering all three EWH dispatcher resolution paths
- **Why:** No way currently exists to verify that project-scope overrides are correctly picked up — contributors and project owners both lack a structured signal
- **Who:** EWH contributors (before merging dispatcher changes) and project owners (confirming their `.claude/` overrides work)
- **Constraints:** EWH is Markdown-only with no test runner; verification signals are the assembled prompt and dispatcher log output during a live run
- **Non-goals:** Automated testing, embedded assertions in the dispatcher, new EWH workflows

## Decision

A standalone manual checklist at `docs/testing-overrides.md`, structured as: shared fixture setup → six inline-fixture checks (one per resolution path) → pass/fail criteria per check.

## Alternatives Considered

| Option | Rejected because |
|---|---|
| Automated EWH workflow | No test runner in a Markdown-only repo |
| Embedded dispatcher assertions | Would add noise to coordinator output for all users |
| Scenario-split (contributor vs. owner) | Duplicates checks; harder to ensure full path coverage |
| Reference matrix (table per path) | Too terse for project owners unfamiliar with dispatcher log format |
| Single canonical fixture at top | Harder to isolate checks; ambiguity about which files are active |

## Acceptance Criteria

- Checklist covers all six resolution paths: agent override, agent extension (`extends:`), rule concatenation, rule recursion (subdirectory), multi-file same basename, workflow override
- Each check specifies: fixture files to create, command to run, exact pass criteria in assembled prompt or dispatcher log, fail signals
- A project owner with no prior EWH knowledge can follow the checklist without reading the dispatcher source

## Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Manual checklist | Automated workflow, embedded assertions | EWH is Markdown-only; no test runner |
| 2 | Lives in `docs/` | `HARNESS.md`, dispatcher `SKILL.md`, fixture project | Keeps dispatcher clean; discoverable by both audiences |
| 3 | Covers both audiences | Contributor-only, owner-only | Same resolution paths affect both; shared fixture avoids duplication |
| 4 | Fixture-first, path-by-path | Scenario-split, reference matrix | Single fixture, systematic coverage; gaps become obvious if dispatcher changes |
| 5 | Both prompt + log as signals | One or the other | Prompt catches content errors; log catches resolution errors |
| 6 | Inline fixtures per check | One canonical fixture at top | Allows isolation; no ambiguity about active files |
| 7 | Minimal test workflow as fixture | Use existing `add-feature` | Avoids multi-step gate noise; isolates the exact agent under test |
