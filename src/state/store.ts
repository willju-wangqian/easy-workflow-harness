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
  state.updated_at = new Date().toISOString();
  await atomicWrite(path, JSON.stringify(state, null, 2));
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
