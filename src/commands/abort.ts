/**
 * `ewh abort [<run-id>]` — mark a run aborted and clear its ACTIVE marker.
 *
 * Single-turn. Delegates the actual mutation to `runReport({ kind: 'abort' })`
 * so the abort path matches `ewh report --abort` exactly (no duplicated
 * state-mutation logic).
 *
 * Disambiguation when `<run-id>` is omitted:
 *   - 1 active run   → abort it
 *   - 0 active runs  → error "no active run to abort", exit 1
 *   - >1 active runs → error listing IDs + suggest `ewh abort <run-id>`, exit 1
 */

import { scanRuns } from '../state/store.js';
import { runReport } from './report.js';

export type AbortOptions = {
  projectRoot: string;
  pluginRoot: string;
  /** Positional `<run-id>` from argv, if any. */
  runId?: string;
};

export async function runAbort(opts: AbortOptions): Promise<string> {
  const runs = await scanRuns(opts.projectRoot);

  if (opts.runId !== undefined) {
    const match = runs.find((r) => r.run_id === opts.runId);
    if (!match) {
      throw new Error(`run not found: ${opts.runId}`);
    }
    if (match.status !== 'running') {
      throw new Error(`run ${match.run_id} is already ${match.status}`);
    }
    return delegateAbort(opts, match.run_id, match.current_step_index);
  }

  const active = runs.filter((r) => r.is_active && r.status === 'running');
  if (active.length === 0) {
    throw new Error('no active run to abort');
  }
  if (active.length > 1) {
    const ids = active.map((r) => `  ${r.run_id}  ${r.workflow}`).join('\n');
    throw new Error(
      `multiple active runs; specify one:\n${ids}\n\nTry: ewh abort <run-id>`,
    );
  }
  const only = active[0]!;
  return delegateAbort(opts, only.run_id, only.current_step_index);
}

async function delegateAbort(
  opts: AbortOptions,
  runId: string,
  stepIndex: number,
): Promise<string> {
  return runReport({
    projectRoot: opts.projectRoot,
    pluginRoot: opts.pluginRoot,
    runId,
    stepIndex,
    report: { kind: 'abort' },
  });
}
