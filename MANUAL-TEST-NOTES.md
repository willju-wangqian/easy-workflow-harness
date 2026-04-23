# Manual Test Notes — Session 6 Context Contract

## UX nit: `manage` REPORT_WITH always says `--step 0`

Repro: `/ewh:doit manage legacy-demo` on a 2-step workflow.

Every per-field prompt's `REPORT_WITH:` line is `ewh report --run <id> --step 0 --decision yes`, even when the banner above says `Step 2/2: 'code' (agent: coder)`. The run completes correctly — the flag value is faithfully what the binary emits — but reading `--step 0` while the header advertises step 2 is dissonant.

Likely cause: `manage` uses internal field-sub-steps under a single top-level step index rather than incrementing `step` per workflow step.

Options:
- Rename the flag semantics for `manage` prompts (e.g. emit `--field-index N` and keep `--step 0` invisible), or
- Increment `--step` so it matches the banner, or
- Add a subtitle like `(internal step 0/14)` so the `--step 0` makes sense to the reader.

Low severity — everything works. Purely a legibility fix.

## RESOLVED: `ewh:artifact-author` exits without writing the file

**Root cause:** `agents/artifact-author.md` set `maxTurns: 3`. The agent typically reads the catalog (turn 1), reads an example file for format reference (turn 2), then tries to Write on turn 3 — but each tool call consumes a turn for the call itself and another for the model to react to the tool result, so the cap fires before the Write lands, let alone the trailing `AGENT_COMPLETE` line. A freshly-dispatched agent never hits `AGENT_COMPLETE` and leaves `staged_path` empty.

**Fix:** raised `maxTurns` from 3 to 8 and tightened the instructions: forbid browsing additional examples on `op: create` and state up-front that "Write to staged_path" is mandatory. Also clarified that the agent should copy `shape_entry.frontmatter` verbatim into the YAML header rather than inventing fields.

## RESOLVED (collateral): scope rewrite skipped frontmatter.scope

Symptom: at shape gate in a non-plugin project, `applyScopeRewrites` (src/commands/design.ts) rewrote the top-level `artifact.scope: plugin → project` but left nested `artifact.frontmatter.scope: "plugin"`. The authored YAML front-matter would have disagreed with the file's actual on-disk location under project `rules/` / `agents/`.

Fix: cascade the rewrite into `a.frontmatter.scope` inside `applyScopeRewrites`. Added regression test `tests/integration-design.test.ts` → "scope:plugin auto-rewrite cascades to frontmatter".


## Minor: "Saved workflow" output when nothing changed

At the end of an all-keep-default `manage` run, the output shows:

```
Saved workflow 'legacy-demo':
  ~ .claude/ewh-workflows/legacy-demo.json
  ~ .claude/ewh-workflows/legacy-demo.md
```

JSON is byte-identical to the pre-run snapshot (idempotence verified via `cmp`), but mtime still moved and the message implies a write. Consider printing `unchanged` when the merged contract hashes match the pre-state.

## Question: design-facilitator skips the interview on unambiguous descriptions

Repro: `/ewh:doit design "a rule about keeping function names under 30 chars"`.

The `ewh:design-facilitator` agent went straight from dispatch to writing `shape.json` — zero `AskUserQuestion` calls. The skill's contract says "Every question MUST include a 'propose now' option so the user can signal readiness at any turn." With zero questions, that contract is moot.

Two readings:
- **Intended fast-path**: descriptions that fully specify the artifact (type, name, single-sentence behavior) shouldn't waste a turn asking. The facilitator inferred `type: rule`, severity `warning`, `inject_into: [coder, reviewer]`, and a `verify` strategy on its own.
- **Bug**: the facilitator was over-eager and silently chose key fields (severity, inject_into, verify command) that the user might have wanted to weigh in on. None of those choices surface at the shape gate — only `description` and `path` do.

Decide: document this as the explicit happy path, or require at least one confirmation question before the proposal so the user sees the inferred fields.

## Minor: shape gate preview hides inferred frontmatter keys

At the shape gate in a `design` run, the artifact preview only shows:

```
[create] rule 'function-name-length' (project) → rules/function-name-length.md
     Function names must be 30 characters or fewer
```

`severity`, `inject_into`, and `verify` are decided in the proposal but only become visible at the per-file gate (in the YAML front-matter). A user who approves shape and skim-reads the file body could miss that, e.g., `inject_into: [coder, reviewer]` was chosen for them.

Consider expanding the shape preview to include any non-default frontmatter keys, e.g.:

```
[create] rule 'function-name-length' (project) → rules/function-name-length.md
     Function names must be 30 characters or fewer
     severity=warning  inject_into=[coder, reviewer]
```
