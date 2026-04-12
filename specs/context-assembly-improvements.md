---
name: context-assembly-improvements
type: decision
status: accepted
scope: [dispatcher, workflows, documentation]
created: 2026-04-11
---

# Context Assembly Improvements

## Understanding

Two improvements to how agents receive context in EWH:

1. **CLAUDE.md size warning** — Document that large CLAUDE.md files inject irrelevant sections into every spawned agent, degrading context quality. Notes in both CLAUDE.md and HARNESS.md.
2. **Explicit `context:` field** — Replace the implicit Prior Steps heuristic (dependencies + immediate predecessor) with an explicit workflow-level declaration of which prior steps each agent receives and at what detail level.

**Problem**: The "immediate predecessor" rule (§4.4 rule c) is a guess — e.g., the tester gets the reviewer's summary even though it primarily needs the coder's output. No mechanism exists to control detail level per source.

**Non-goals**: No CLAUDE.md section-level filtering mechanism (documentation only). No changes to agent templates or rule injection logic.

## Decision

### 1. New `context:` field on workflow steps

```yaml
context:
  - step: <step-name>    # must match a step name in the same workflow
    detail: raw | full | summary
```

**Detail levels:**
- `raw` — full uncompressed agent output (defined but not used in current workflows)
- `full` — richer summary: key decisions, file-level changes with descriptions, approach taken, issues encountered (~5-10 bullets)
- `summary` — compressed: status, 1-3 key bullets, file list
- Omit (don't list the step) — not included at all

**Replaces** Prior Steps rules a/b/c in §4.4 entirely. Steps not listed in `context:` are never included. If `context:` is absent or empty, the agent gets no ## Prior Steps section.

**`requires:` becomes purely a precondition gate** — it no longer implies context inclusion. If you want context from a dependency, list it in both `requires:` and `context:`.

### 2. Dispatcher changes (SKILL.md)

§4.4 rewritten to:
> For each entry in `step.context`, include the named step's summary compressed to the declared detail level. If `step.context` is absent or empty, omit the ## Prior Steps section entirely.

Error handling additions:
- `context:` names a step that doesn't exist → warn, skip that context entry
- `context:` names a step that was skipped (precondition failed) → include skip summary at declared detail level

### 3. Documentation notes

**CLAUDE.md (Key Contracts):**
> **CLAUDE.md size impact**: Every spawned agent receives the project's CLAUDE.md under ## Project Context. Large CLAUDE.md files inject irrelevant sections into agents that don't need them, consuming context window and potentially diluting focus. Keep CLAUDE.md concise — architecture overview, key commands, conventions, and Harness Config only.

**HARNESS.md (Project Integration):**
> The full content of the project's CLAUDE.md is injected into every agent's ## Project Context section. Large or unfocused CLAUDE.md files will degrade agent context quality by including irrelevant information. Prefer concise, high-signal content. Detailed documentation belongs in dedicated files, not CLAUDE.md.

**CLAUDE.md (Extending the Harness):**
> Add `context:` to optional step fields documentation and update "Prompt assembly order" to note Prior Steps is governed by `context:`.

## Workflow Updates

### add-feature

| Step | Context |
|---|---|
| plan | `[]` |
| code | plan: full |
| review | code: full |
| test | code: full, review: summary |

### refine-feature

| Step | Context |
|---|---|
| scan | `[]` |
| propose | scan: full |
| code | propose: full |
| review | code: full |
| test | code: full, review: summary |

### check-fact

| Step | Context |
|---|---|
| scan-docs | `[]` |
| validate | scan-docs: full |
| propose-fixes | validate: full |
| apply-fixes | propose-fixes: full |

### update-knowledge

| Step | Context |
|---|---|
| read-governance | `[]` |
| inspect-state | read-governance: summary |
| apply-updates | inspect-state: full |

### clean-up

| Step | Context |
|---|---|
| test | `[]` |
| check | test: summary |
| build-docs | test: summary, check: summary |
| update-knowledge (sub) | test: summary, check: summary, build-docs: summary |

### init

All steps: `[]` (null-agent, dispatcher has full conversation context)

## Alternatives Considered

| Option | Rejected because |
|---|---|
| Shorthand syntax (`context: [code, review]` with default detail) | Mixed syntax (string array vs object array) creates parsing ambiguity for Claude-as-parser |
| Separate fields per level (`context_full:`, `context_summary:`) | Proliferates fields, awkward when adding levels |
| Override-only field (keep implicit rules, add `context_override:`) | Less boilerplate but more complex mental model; implicit rules are inherently guesswork |
| Coexist with `requires:` auto-inclusion | Dual-purpose `requires:` conflates gating with context; clean separation preferred |
| CLAUDE.md section-level filtering mechanism | Adds complexity disproportionate to the problem; documentation warning is sufficient |

## Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Explicit `context:` with step + detail objects | Uniform structure; Claude-as-parser needs zero ambiguity |
| 2 | Completely replaces Prior Steps rules a/b/c | Explicit over implicit; removes "immediate predecessor" guess |
| 3 | `requires:` is purely gating | Clean separation of concerns |
| 4 | Four levels: raw > full > summary > omit | raw covers edge cases; omit = don't list |
| 5 | `raw` not used in current workflows | YAGNI — define it, don't use it until needed |
| 6 | CLAUDE.md filtering = documentation only | Warning is proportionate to the problem |
| 7 | Notes in both CLAUDE.md and HARNESS.md | Different audiences: practitioner vs system behavior |

## Acceptance Criteria

- [ ] SKILL.md §4.4 rewritten to use `context:` field
- [ ] SKILL.md §8 error table updated with context-related scenarios
- [ ] All 6 workflows have explicit `context:` fields on every step
- [ ] CLAUDE.md has CLAUDE.md size impact note under Key Contracts
- [ ] CLAUDE.md Extending the Harness documents `context:` field
- [ ] CLAUDE.md Prompt assembly order updated
- [ ] HARNESS.md has context quality note under Project Integration
- [ ] No workflow uses `raw` detail level
