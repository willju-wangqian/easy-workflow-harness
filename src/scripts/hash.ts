import { createHash } from 'node:crypto';
import type { Step } from '../state/types.js';

/**
 * Stable hash of the step definition fields that determine what a cached
 * script is expected to do. Used to detect staleness after the workflow is
 * edited.
 */
export function hashStep(step: Step): string {
  const payload = JSON.stringify({
    name: step.name,
    description: step.description ?? '',
    rules: (step.rules ?? []).slice().sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
}
