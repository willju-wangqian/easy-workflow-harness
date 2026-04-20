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

  // Filter out ACTIVE runs
  const candidates: { name: string; updatedAt: string }[] = [];
  for (const name of runDirs) {
    const activeFile = join(artifactsDir, name, 'ACTIVE');
    try {
      await fs.access(activeFile);
      // ACTIVE marker exists — skip
      continue;
    } catch {
      // no ACTIVE marker — candidate for pruning
    }
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
