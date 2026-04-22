/**
 * Adapter: WorkflowContract (JSON, Session 1) → WorkflowDef (legacy Step
 * shape used by the state machine). Session 2.
 *
 * The state machine and prompt-builder already know how to run a
 * WorkflowDef. Rather than plumb a second representation through
 * downstream code, we convert the typed contract into Step entries:
 *
 *   context[].type === 'rule'               → step.rules (names)
 *   context[].type === 'artifact' | 'file'  → step.reads (paths)
 *
 * The full `context_entries` array is also preserved on each step so
 * prompt-builder (and later sessions' design/manage/diff tooling) can
 * see the original typed grouping.
 *
 * `produces[0]` becomes `step.artifact` — the primary output slot the
 * state machine reads during `artifact_verify`. Additional `produces`
 * entries remain visible to the contract but don't map to legacy Step
 * fields.
 */

import type { ContextEntry, WorkflowContract } from './contract.js';
import type { Step, WorkflowDef } from '../state/types.js';

export function contractToWorkflowDef(contract: WorkflowContract): WorkflowDef {
  return {
    name: contract.name,
    description: contract.description || undefined,
    steps: contract.steps.map(contractStepToStep),
  };
}

function contractStepToStep(
  cs: WorkflowContract['steps'][number],
): Step {
  const rules: string[] = [];
  const reads: string[] = [];
  for (const entry of cs.context) {
    if (entry.type === 'rule') rules.push(entry.ref);
    else reads.push(entry.ref);
  }

  return {
    name: cs.name,
    agent: cs.agent || undefined,
    gate: cs.gate === 'structural' ? 'structural' : 'auto',
    description: cs.description || undefined,
    rules: rules.length > 0 ? rules : undefined,
    reads: reads.length > 0 ? reads : undefined,
    artifact: cs.produces[0] ?? undefined,
    context_entries: cs.context.map(cloneEntry),
    requires: cs.requires.length > 0 ? cs.requires : undefined,
    chunked: cs.chunked ? true : undefined,
    script: cs.script ?? undefined,
    script_fallback: cs.script_fallback,
    state: { phase: 'pending' },
  };
}

function cloneEntry(e: ContextEntry): ContextEntry {
  return { type: e.type, ref: e.ref } as ContextEntry;
}
