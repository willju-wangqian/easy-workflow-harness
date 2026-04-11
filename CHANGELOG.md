# Changelog

All notable changes to Easy Workflow Harness are documented here.

## [0.9.2] - 2026-04-11

### Added
- Explicit `context:` field on workflow steps — replaces implicit Prior Steps heuristic. Steps now declare exactly which prior steps they receive and at what detail level (`raw`, `full`, `summary`).
- Scanner agent — dedicated read-only agent for analyzing existing code and documentation, split out from the reviewer role.
- Three scaffold workflows: `create-rules`, `create-agents`, `create-workflow` — guided creation of project-specific rules, agents, and workflows with plan, propose, create, and review steps.

### Changed
- README restructured: reference-first content order, navigational catalog, Mermaid flow diagram, "Creating Your Own" content moved to `docs/customization.md`.

### Fixed
- Dispatcher no longer injects CLAUDE.md into `## Project Context` (the runtime already provides it to subagents).
- Prior Steps, rules, and Project Context are now filtered for agent relevance instead of injecting everything.
- README rewritten for beginner-friendly onboarding.

## [0.9.1] - 2026-04-11

### Added
- `artifact:` and `reads:` directives for inter-step artifact handoff.
- `requires:` preconditions on workflow steps (`prior_step` + `has`, `file_exists`).
- Agent self-gating via mandatory `## Before You Start` sections — agents bail with `AGENT_COMPLETE` when context is insufficient.
- AGENT_COMPLETE sentinel protocol for detecting partial agent output.
- Continuation flow — on partial output, spawns one retry with skip instructions.
- Split/merge flow — chunks large tasks (>30 items) into parallel batches, then merges results.
- Compliance agent — lightweight post-step auditor for `severity: critical` rules.
- Sub-workflow support with shared artifact workspace and context propagation.

### Fixed
- Artifact verification now works for non-agent executor types.
- Reviewer self-gating allows scan mode (no prior `files_modified` required).
- Seven dispatcher bugs in step sequencing, workflow resolution, and documentation accuracy.

## [0.9.0] - 2026-04-11

Initial release.

- Dispatcher (`/ewh:doit`) with workflow resolution, gate system, and prompt assembly.
- 6 workflows: `add-feature`, `refine-feature`, `fact-check`, `knowledge-update`, `clean-up`, `init`.
- 4 agents: coder, reviewer, tester, compliance.
- 4 rules: coding, review, testing, knowledge.
- Three-level project integration: zero-config, init'd, customized.
- Override resolution: project `.claude/` takes precedence for agents and workflows; rules concatenate.
- MIT license.
