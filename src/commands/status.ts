/**
 * `ewh status` — report in-flight and recent runs.
 *
 * Single-turn. Scans `.ewh-artifacts/`, emits one line per active run:
 *   <run-id>  <workflow>  step-<N>/<T>  <phase>  <age>
 *
 * Empty case prints `No active runs.` and, when a terminal run exists,
 * a `Last: ...` hint for `ewh resume`.
 * Stale runs (ACTIVE marker with dead PID) are flagged with `[stale]`.
 * A footer shows how many completed runs are retained on disk.
 */

import { scanRuns, type RunSummary } from '../state/store.js';
import { readArtifactRetention } from '../state/workflow-settings.js';
import type { Instruction } from '../state/types.js';

export type StatusOptions = {
  projectRoot: string;
};

export async function buildStatusInstruction(opts: StatusOptions): Promise<Instruction> {
  const body = await buildStatusBody(opts.projectRoot, new Date());
  return { kind: 'done', body };
}

export async function buildStatusBody(projectRoot: string, now: Date): Promise<string> {
  const [runs, { maxRuns }] = await Promise.all([
    scanRuns(projectRoot, now),
    readArtifactRetention(projectRoot),
  ]);

  const active = runs.filter((r) => r.is_active && r.status === 'running');
  const stale = runs.filter((r) => r.is_stale);
  const retained = runs.filter((r) => !r.is_stale && r.status !== 'running');

  const lines: string[] = [];

  const activeRows = active.map((r) => toStatusRow(r, now, false));
  const staleRows = stale.map((r) => toStatusRow(r, now, true));
  const allRows = [...activeRows, ...staleRows];

  if (allRows.length > 0) {
    lines.push(...renderStatusRows(allRows));
  } else {
    lines.push('No active runs.');
    if (retained.length > 0) {
      const last = retained[0]!;
      lines.push(
        `Last: ${last.run_id}  ${last.workflow}  ${last.status}  ${formatAge(last.updated_at, now)}`,
      );
    }
  }

  if (retained.length > 0) {
    const maxLabel = maxRuns === 'keep' ? 'keep' : String(maxRuns);
    lines.push(
      `(${retained.length} completed run${retained.length === 1 ? '' : 's'} retained for debug · max_runs=${maxLabel})`,
    );
  }

  return lines.join('\n');
}

type StatusRow = {
  run_id: string;
  workflow: string;
  stepFrag: string;
  phase: string;
  age: string;
  stale: boolean;
};

function toStatusRow(r: RunSummary, now: Date, stale: boolean): StatusRow {
  const stepFrag =
    r.total_steps > 0 ? `step-${r.current_step_index + 1}/${r.total_steps}` : 'subcommand';
  return { run_id: r.run_id, workflow: r.workflow, stepFrag, phase: r.current_phase, age: formatAge(r.updated_at, now), stale };
}

function renderStatusRows(rows: StatusRow[]): string[] {
  const hasStale = rows.some((r) => r.stale);
  const wW = Math.max(...rows.map((r) => r.workflow.length));
  const wS = Math.max(...rows.map((r) => r.stepFrag.length));
  const wP = Math.max(...rows.map((r) => r.phase.length));
  return rows.map((r) => {
    const tag = hasStale ? (r.stale ? '[stale] ' : '        ') : '';
    const core = [r.run_id, r.workflow.padEnd(wW), r.stepFrag.padEnd(wS), r.phase.padEnd(wP), r.age].join('  ');
    const suffix = r.stale ? `  — run \`ewh abort ${r.run_id}\`` : '';
    return `${tag}${core}${suffix}`;
  });
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
