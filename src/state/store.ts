/**
 * Atomic state persistence for the dispatcher binary.
 *
 * Run state lives at `.ewh-artifacts/<run_id>/state.json`. An `ACTIVE`
 * marker file at the run directory signals an in-flight run to
 * subsequent `/ewh:doit` invocations (crash-resume support, per spec
 * §Error Handling).
 *
 * Every write is atomic: write to a sibling tmp file, fsync it, then
 * rename over the target. Partial writes are impossible on POSIX.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { RunState } from './types.js';

const ARTIFACTS_DIR = '.ewh-artifacts';

export function runDir(projectRoot: string, runId: string): string {
  return resolve(projectRoot, ARTIFACTS_DIR, `run-${runId}`);
}

export function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), 'state.json');
}

export function activeMarker(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), 'ACTIVE');
}

export function newRunId(): string {
  // 8 hex chars ≈ 32 bits of entropy — ample for the single-user, ≤10/day
  // workload assumed in spec §Assumptions.
  return randomBytes(4).toString('hex');
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

export async function writeRunState(
  projectRoot: string,
  state: RunState,
): Promise<void> {
  const path = statePath(projectRoot, state.run_id);
  const stamped = { ...state, updated_at: new Date().toISOString() };
  await atomicWrite(path, JSON.stringify(stamped, null, 2));
}

export async function readRunState(
  projectRoot: string,
  runId: string,
): Promise<RunState> {
  const body = await fs.readFile(statePath(projectRoot, runId), 'utf8');
  return JSON.parse(body) as RunState;
}

export async function markActive(
  projectRoot: string,
  runId: string,
): Promise<void> {
  await fs.mkdir(runDir(projectRoot, runId), { recursive: true });
  await fs.writeFile(activeMarker(projectRoot, runId), `${process.pid}\n`, 'utf8');
}

export async function clearActive(
  projectRoot: string,
  runId: string,
): Promise<void> {
  await fs.rm(activeMarker(projectRoot, runId), { force: true });
}

export async function pruneOldRuns(
  projectRoot: string,
  maxRuns: number | 'keep',
): Promise<void> {
  if (maxRuns === 'keep') return;

  const artifactsDir = resolve(projectRoot, ARTIFACTS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(artifactsDir);
  } catch {
    return;
  }

  const runDirs = entries.filter((e) => e.startsWith('run-'));

  const candidates: { name: string; updatedAt: string }[] = [];
  for (const name of runDirs) {
    const activeFile = join(artifactsDir, name, 'ACTIVE');
    let trulyActive = false;
    try {
      const pidContent = await fs.readFile(activeFile, 'utf8');
      const pid = Number(pidContent.trim());
      trulyActive = isPidAlive(pid);
    } catch {
      // No ACTIVE file or unreadable → not active
    }
    if (trulyActive) continue;

    let updatedAt = '1970-01-01T00:00:00.000Z';
    try {
      const stateFile = join(artifactsDir, name, 'state.json');
      const body = await fs.readFile(stateFile, 'utf8');
      const parsed = JSON.parse(body) as { updated_at?: string };
      if (parsed.updated_at) updatedAt = parsed.updated_at;
    } catch {
      try {
        const stat = await fs.stat(join(artifactsDir, name));
        updatedAt = stat.mtime.toISOString();
      } catch {
        // stat failed → epoch (pruned first)
      }
    }
    candidates.push({ name, updatedAt });
  }

  // Sort newest first (ISO 8601 strings sort lexicographically)
  candidates.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0));

  const toDelete = candidates.slice(maxRuns);
  for (const { name } of toDelete) {
    await fs.rm(join(artifactsDir, name), { recursive: true, force: true });
  }
}

export type RunSummary = {
  run_id: string;
  workflow: string;
  status: 'running' | 'complete' | 'aborted';
  current_step_index: number;
  total_steps: number;
  current_phase: string;
  is_active: boolean;
  is_stale: boolean;
  updated_at: string;
};

/**
 * Enumerate runs in `.ewh-artifacts/`. Returns all parseable runs; emits
 * stderr warnings for malformed state files (does not throw).
 *
 * Sort order: active+running first, then by `updated_at` descending.
 */
const STALE_AGE_MS = 48 * 60 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

export async function scanRuns(projectRoot: string, now: Date = new Date()): Promise<RunSummary[]> {
  const artifactsDir = resolve(projectRoot, ARTIFACTS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(artifactsDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const summaries: RunSummary[] = [];
  for (const name of entries) {
    if (!name.startsWith('run-')) continue;
    const runId = name.slice('run-'.length);
    const stPath = statePath(projectRoot, runId);
    let state: RunState;
    try {
      const body = await fs.readFile(stPath, 'utf8');
      state = JSON.parse(body) as RunState;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        process.stderr.write(`[ewh] warning: ${stPath} unreadable: ${String(err)}\n`);
      }
      continue;
    }
    let isActive = false;
    let isStale = false;
    const markerPath = activeMarker(projectRoot, runId);
    try {
      const pidContent = await fs.readFile(markerPath, 'utf8');
      const pid = Number(pidContent.trim());
      if (isPidAlive(pid)) {
        const ageMs = now.getTime() - Date.parse(state.updated_at);
        if (state.status === 'running' && Number.isFinite(ageMs) && ageMs > STALE_AGE_MS) {
          // PID recycled by OS — run is stuck and stale; auto-clear so pruning can reclaim it
          isStale = true;
          await fs.rm(markerPath, { force: true });
        } else {
          isActive = true;
        }
      } else if (state.status === 'running') {
        // PID dead, run stuck in running state — auto-clear so pruning can reclaim it
        isStale = true;
        await fs.rm(markerPath, { force: true });
      }
      // PID dead + terminal status: isActive=false, isStale=false (treat as completed)
    } catch {
      /* no ACTIVE marker */
    }
    const step = state.steps?.[state.current_step_index];
    const phase = step?.state?.phase ?? state.subcommand ?? 'unknown';
    summaries.push({
      run_id: state.run_id,
      workflow: state.workflow,
      status: state.status,
      current_step_index: state.current_step_index,
      total_steps: state.steps?.length ?? 0,
      current_phase: phase,
      is_active: isActive,
      is_stale: isStale,
      updated_at: state.updated_at,
    });
  }

  summaries.sort((a, b) => {
    const priority = (r: RunSummary): number => {
      if (r.is_active && r.status === 'running') return 2;
      if (r.is_stale) return 1;
      return 0;
    };
    const ap = priority(a);
    const bp = priority(b);
    if (ap !== bp) return bp - ap;
    return b.updated_at.localeCompare(a.updated_at);
  });
  return summaries;
}
