import { resolve } from 'node:path';
import type { Step } from '../state/types.js';
import { readCachedScript } from './cache.js';
import { hashStep } from './hash.js';

export type ScriptDecision =
  | { kind: 'explicit'; scriptPath: string }
  | { kind: 'cached'; scriptPath: string; stale: boolean }
  | { kind: 'propose' }
  | { kind: 'agent' };

/**
 * A step is scriptable when it has an agent but no input/output coupling that
 * requires the LLM (no reads, no artifact, no context refs, not chunked).
 */
export function isScriptable(step: Step): boolean {
  return !!(
    step.agent &&
    !step.chunked &&
    !(step.reads?.length) &&
    !step.artifact &&
    !(step.context?.length)
  );
}

export async function evaluateScript(
  projectRoot: string,
  workflow: string,
  step: Step,
): Promise<ScriptDecision> {
  if (step.script) {
    const scriptPath = step.script.startsWith('/')
      ? step.script
      : resolve(projectRoot, step.script);
    return { kind: 'explicit', scriptPath };
  }

  const cached = await readCachedScript(projectRoot, workflow, step.name);
  if (cached) {
    const currentHash = hashStep(step);
    const stale = cached.storedHash !== null && cached.storedHash !== currentHash;
    return { kind: 'cached', scriptPath: cached.path, stale };
  }

  if (isScriptable(step)) {
    return { kind: 'propose' };
  }

  return { kind: 'agent' };
}
