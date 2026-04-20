/**
 * `ewh status` — report in-flight and recent runs.
 *
 * Single-turn. Scans `.ewh-artifacts/`, emits one line per active run:
 *   <run-id>  <workflow>  step-<N>/<T>  <phase>  <age>
 *
 * Empty case prints `No active runs.` and, when a terminal run exists,
 * a `Last: ...` hint for `ewh resume`.
 */

import { scanRuns, type RunSummary } from '../state/store.js';
import type { Instruction } from '../state/types.js';

export type StatusOptions = {
  projectRoot: string;
};

export async function buildStatusInstruction(opts: StatusOptions): Promise<Instruction> {
  const body = await buildStatusBody(opts.projectRoot, new Date());
  return { kind: 'done', body };
}

export async function buildStatusBody(projectRoot: string, now: Date): Promise<string> {
  const runs = await scanRuns(projectRoot);
  const active = runs.filter((r) => r.is_active && r.status === 'running');
  if (active.length > 0) {
    return active.map((r) => formatActiveLine(r, now)).join('\n');
  }
  const terminal = runs.find((r) => r.status !== 'running');
  if (!terminal) {
    return 'No active runs.';
  }
  return `No active runs.\nLast: ${terminal.run_id}  ${terminal.workflow}  ${terminal.status}  ${formatAge(terminal.updated_at, now)}`;
}

function formatActiveLine(r: RunSummary, now: Date): string {
  const stepFrag = r.total_steps > 0
    ? `step-${r.current_step_index + 1}/${r.total_steps}`
    : `subcommand`;
  return `${r.run_id}  ${r.workflow}  ${stepFrag}  ${r.current_phase}  ${formatAge(r.updated_at, now)}`;
}

export function formatAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '?';
  const deltaSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}
