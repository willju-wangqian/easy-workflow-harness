---
name: partial-output-handling
type: decision
status: accepted
scope: [dispatcher, agents, reliability]
created: 2026-04-09
---

## Understanding Summary

- **What**: Three coordinated changes to EWH — sentinel detection, automatic task splitting, and merge-agent synthesis
- **Why**: Agents hitting `maxTurns` return partial output silently; the dispatcher cannot distinguish success from truncation
- **Who**: The dispatcher (SKILL.md) and all agent templates in the harness
- **Key constraint**: No recursive splitting — chunk failures gate to user
- **Non-goals**: No fixed chunk size config, no per-step declarations, no per-agent opt-in flag

## Decision

### 1. Sentinel Protocol

Every agent template emits `AGENT_COMPLETE` as the last line of its response. The dispatcher checks for this string in raw agent output after every Agent tool call.

- Present → output is complete, proceed normally
- Absent → output is partial, enter split flow

The sentinel instruction is added to the `## Output Format` section of all 4 agent templates: `coder.md`, `reviewer.md`, `tester.md`, `compliance.md`.

### 2. Split Flow (added as §6a in SKILL.md)

**Infer item count:** Count lines in the original agent prompt matching:
- Numbered items: `^\s*[A-Z]?\d+[.):] `
- Bulleted items: `^\s*[-*•] `

**Threshold logic:**
- Count ≤ 30 → do NOT split. Gate and offer retry / skip / abort. (Task is small; agent likely crashed for another reason.)
- Count > 30 → split into chunks of 30 items each.

**Build chunk prompts:**
- Preamble = everything before the first matched item line
- Chunk body = items N through N+29
- Postamble = everything after the last item line (output format, project context)
- Each chunk prompt = preamble + chunk body + postamble

**Execute:** Spawn all chunk agents in parallel (same `subagent_type` and rules as original step). Each chunk must emit `AGENT_COMPLETE`.

**Chunk failure:** If any chunk returns without `AGENT_COMPLETE` → gate, ask user: retry that chunk / skip / abort. No recursive splitting.

### 3. Merge Agent (added as §6b in SKILL.md)

After all chunks complete, spawn one final agent of the same `subagent_type`:

```
## Role
You are synthesizing results from N parallel verification chunks into one unified report.
Do not re-verify anything. Combine and deduplicate only.

## Chunk Results
[chunk 1 output]
---
[chunk 2 output]
---
...

## Task
Produce a single unified report in the output format defined below.
Remove duplicate findings. Preserve all stale/wrong claims with their evidence.
Aggregate confirmed counts across chunks.

## Output Format
[same output format block as the original agent template]

At the very end of your response, after all other output, emit exactly:
AGENT_COMPLETE
```

The merge agent's output becomes the canonical step result, fed into §6 Collect Result as normal.

If the merge agent returns without `AGENT_COMPLETE` → gate, ask user: retry merge / skip / abort.

## Alternatives Considered

| Decision | Alternatives rejected |
|---|---|
| Split on partial (not retry same step) | Retry with higher maxTurns — doesn't help if the task is fundamentally too large |
| `AGENT_COMPLETE` sentinel | Output format validation (fragile, per-agent); heuristic (unreliable) |
| All agent templates get sentinel | Opt-in via frontmatter — adds configuration complexity for no benefit |
| Dispatcher infers chunk size | Fixed config in HARNESS.md; workflow-declared `max_chunk` — adds syntax with no advantage |
| Parallel chunk execution | Sequential — parallel is faster and chunks are independent |
| Merge agent (same subagent_type) | Dispatcher synthesizes — structured merge is more reliable; concatenate — loses deduplication |
| Chunk partial failure → gate | Recursive split — prevents infinite recursion; user stays in control |

## Acceptance Criteria

- [ ] All 4 agent templates emit `AGENT_COMPLETE` as last line
- [ ] Dispatcher §6 checks for sentinel after every agent call
- [ ] Dispatcher §6a: infers item count, splits >30-item prompts into 30-item chunks
- [ ] Chunks run in parallel, same subagent_type as original step
- [ ] Dispatcher §6b: merge agent synthesizes all chunk outputs
- [ ] Chunk or merge failure → gate (not silent pass-through, not recursive split)
- [ ] Error handling table updated to remove any SendMessage references
