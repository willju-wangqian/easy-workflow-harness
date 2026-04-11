---
name: partial-output-handling
type: decision
status: accepted
scope: [dispatcher, agents, reliability]
created: 2026-04-09
amended: 2026-04-10
---

## Understanding Summary

- **What**: Four coordinated changes to EWH — sentinel detection, continuation agent, automatic task splitting, and merge-agent synthesis
- **Why**: Agents hitting `maxTurns` return partial output silently; the dispatcher cannot distinguish success from truncation
- **Who**: The dispatcher (SKILL.md) and all agent templates in the harness
- **Key constraint**: No recursive splitting — chunk failures gate to user; continuation is one attempt only
- **Non-goals**: No fixed chunk size config, no per-step declarations, no per-agent opt-in flag

## Decision

### 1. Sentinel Protocol

Every agent template emits `AGENT_COMPLETE` as the last line of its response. The dispatcher checks for this string in raw agent output after every Agent tool call.

- Present → output is complete, proceed normally
- Absent → output is partial, enter §6c Continuation Flow

The sentinel instruction is added to the `## Output Format` section of all 4 agent templates: `coder.md`, `reviewer.md`, `tester.md`, `compliance.md`.

### 2. §6c Continuation Flow (first intervention on partial output)

When `AGENT_COMPLETE` is absent, before any split decision, spawn one continuation agent using the same `subagent_type` and `model` as the original step.

**Continuation prompt** (assembled in standard order):

```
[agent template — role, behavior, output format]

## Active Rules
[identical to original call]

## Prior Steps
[identical to original call]

## Partial Output (Previous Attempt)
[raw partial output from the interrupted agent]

## Task
[original task description]

## Continuation Instructions
The previous attempt was interrupted before completing.
The Partial Output section above shows what was already addressed.
- Skip all items already present in the Partial Output
- Continue only with remaining items
- Produce output in the same format, as if completing the full task
- At the very end of your response, emit exactly: AGENT_COMPLETE
```

**Outcomes:**
- AGENT_COMPLETE present → treat continuation output as canonical result, return to §6 Collect Result
- Still absent, or agent crashes → silent fallthrough to §6a Split Flow using remaining items

§6c is a transparent optimization layer — no user-facing gate.

### 3. §6a Split Flow (fallthrough from §6c)

**Infer remaining item count:** When falling through from §6c with a partial output, diff the original items against the partial output to find uncompleted items. An item is considered done if its text (stripped of leading numbering/bullets) appears anywhere in the partial output. When §6c crashes with no partial output, use the full original item set.

Count lines in the relevant item set matching:
- Numbered items: `^\s*[A-Z]?\d+[.):] `
- Bulleted items: `^\s*[-*•] `

**Threshold logic:**
- Count ≤ 30 → do NOT split. Gate — show partial output, offer: retry / skip / abort. (Task is small; agent likely crashed for another reason.)
- Count > 30 → split into chunks of 30 items each.

**Build chunk prompts:**
- Preamble = everything before the first matched item line in the original prompt
- Chunk body = remaining items N through N+29
- Postamble = everything after the last item line (output format, project context)
- Each chunk prompt = preamble + chunk body + postamble
- Do NOT include `## Partial Output` in chunk prompts — chunk agents start fresh on their assigned slice

**Execute:** Spawn all chunk agents in parallel (same `subagent_type` and rules as original step). Each chunk must emit `AGENT_COMPLETE`.

**Chunk failure:** If any chunk returns without `AGENT_COMPLETE` → gate, ask user: retry that chunk / skip / abort. No recursive splitting.

### 4. §6b Merge Agent (after all chunks complete)

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
| Split on partial (not retry same prompt) | Retry same prompt fresh — ignores partial progress, risks hitting turns again for same reason |
| Continuation agent skips completed items via instruction | Rely on merge agent to deduplicate — agents don't share context; merge agent can't distinguish duplicate from new |
| Split remaining items only (not full original set) | Re-split full original — re-does completed work unnecessarily |
| No partial output in chunk prompts | Include partial as context — adds noise, risks chunk agents re-processing completed items |
| §6c failure → silent fallthrough | Gate on §6c failure — §6c is an optimization layer; user-facing gate belongs at §6a |
| `AGENT_COMPLETE` sentinel | Output format validation (fragile, per-agent); heuristic (unreliable) |
| All agent templates get sentinel | Opt-in via frontmatter — adds configuration complexity for no benefit |
| Dispatcher infers chunk size | Fixed config in HARNESS.md; workflow-declared `max_chunk` — adds syntax with no advantage |
| Parallel chunk execution | Sequential — parallel is faster and chunks are independent |
| Merge agent (same subagent_type) | Dispatcher synthesizes — structured merge is more reliable; concatenate — loses deduplication |
| Chunk partial failure → gate | Recursive split — prevents infinite recursion; user stays in control |

## Decision Log

| Decision | Alternatives rejected | Reason |
|---|---|---|
| Continuation before split (§6c) | Retry same prompt fresh | Leverages partial progress; cheaper than split+merge |
| Skip completed items via instruction | Rely on merge agent | Agents don't share context; merge can't know what's duplicate vs. new |
| Split remaining items (not full set) | Re-split full original | Avoids re-doing completed work |
| No partial output in chunk prompts | Include partial as context | Adds noise; risks re-processing; chunks are independent |
| §6c failure → silent fallthrough | Gate on §6c failure | §6c is transparent optimization; user gate belongs at §6a |

## Acceptance Criteria

- [ ] All 4 agent templates emit `AGENT_COMPLETE` as last line
- [ ] Dispatcher §6 checks for sentinel after every agent call
- [ ] Dispatcher §6c: on partial output, spawns continuation agent with partial output + skip instruction before split decision
- [ ] §6c success → canonical result, no split
- [ ] §6c failure → silent fallthrough to §6a
- [ ] Dispatcher §6a: infers remaining item count (diffed against partial output); falls back to full set if no partial
- [ ] §6a splits >30-item remaining sets into 30-item chunks; chunk prompts contain no partial output
- [ ] Chunks run in parallel, same subagent_type as original step
- [ ] Dispatcher §6b: merge agent synthesizes all chunk outputs
- [ ] Chunk or merge failure → gate (not silent pass-through, not recursive split)
- [ ] §8 Error Handling table includes: continuation agent partial → silent fallthrough to §6a
