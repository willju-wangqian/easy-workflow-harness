import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildStatusBody, formatAge } from '../src/commands/status.js';
import { writeRunState, markActive, runDir } from '../src/state/store.js';
import type { RunState } from '../src/state/types.js';

function fakeRun(overrides: Partial<RunState>): RunState {
  const now = new Date().toISOString();
  return {
    run_id: 'deadbeef',
    workflow: 'add-feature',
    raw_argv: 'add-feature "x"',
    current_step_index: 0,
    steps: [
      { name: 'plan', gate: 'auto', state: { phase: 'pending' } },
      { name: 'impl', gate: 'auto', state: { phase: 'pending' } },
      { name: 'test', gate: 'auto', state: { phase: 'pending' } },
    ],
    started_at: now,
    updated_at: now,
    status: 'running',
    ...overrides,
  };
}

// Write state then patch updated_at back to a fixed value (writeRunState bumps it).
async function writeWithTs(projectRoot: string, state: RunState, isoTs: string): Promise<void> {
  await writeRunState(projectRoot, state);
  const p = join(runDir(projectRoot, state.run_id), 'state.json');
  const on = JSON.parse(await fs.readFile(p, 'utf8'));
  on.updated_at = isoTs;
  await fs.writeFile(p, JSON.stringify(on));
}

describe('formatAge', () => {
  const now = new Date('2026-04-19T12:00:00Z');
  it('seconds', () => expect(formatAge('2026-04-19T11:59:58Z', now)).toBe('2s ago'));
  it('minutes', () => expect(formatAge('2026-04-19T11:55:00Z', now)).toBe('5m ago'));
  it('hours', () => expect(formatAge('2026-04-19T09:00:00Z', now)).toBe('3h ago'));
  it('days', () => expect(formatAge('2026-04-16T12:00:00Z', now)).toBe('3d ago'));
  it('future clamped to 0s', () => expect(formatAge('2026-04-19T12:00:05Z', now)).toBe('0s ago'));
  it('malformed → ?', () => expect(formatAge('not-a-date', now)).toBe('?'));
});

describe('buildStatusBody', () => {
  let projectRoot: string;
  const now = new Date('2026-04-19T12:00:00Z');

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(join(tmpdir(), 'ewh-status-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('empty artifacts → "No active runs."', async () => {
    expect(await buildStatusBody(projectRoot, now)).toBe('No active runs.');
  });

  it('single active run → one line', async () => {
    await writeWithTs(projectRoot, fakeRun({ run_id: 'aaaaaaaa' }), '2026-04-19T11:50:00Z');
    await markActive(projectRoot, 'aaaaaaaa');
    const body = await buildStatusBody(projectRoot, now);
    expect(body).toBe('aaaaaaaa  add-feature  step-1/3  pending  10m ago');
  });

  it('multiple active runs → one line each, active-first', async () => {
    await writeWithTs(projectRoot, fakeRun({ run_id: 'runold00', current_step_index: 2 }), '2026-04-19T10:00:00Z');
    await markActive(projectRoot, 'runold00');
    await writeWithTs(projectRoot, fakeRun({ run_id: 'runnew00', current_step_index: 1 }), '2026-04-19T11:30:00Z');
    await markActive(projectRoot, 'runnew00');
    const lines = (await buildStatusBody(projectRoot, now)).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^runnew00 /);
    expect(lines[1]).toMatch(/^runold00 /);
    expect(lines[0]).toContain('step-2/3');
    expect(lines[1]).toContain('step-3/3');
  });

  it('no active runs + terminal run exists → "No active runs." + Last: line', async () => {
    await writeWithTs(projectRoot, fakeRun({ run_id: 'doneaaaa', status: 'complete' }), '2026-04-19T11:00:00Z');
    const body = await buildStatusBody(projectRoot, now);
    expect(body).toBe('No active runs.\nLast: doneaaaa  add-feature  complete  1h ago');
  });

  it('terminal + stale ACTIVE marker → ignored in active count; shows in Last', async () => {
    await writeWithTs(projectRoot, fakeRun({ run_id: 'staleaaa', status: 'aborted' }), '2026-04-19T11:30:00Z');
    await markActive(projectRoot, 'staleaaa'); // stale marker
    const body = await buildStatusBody(projectRoot, now);
    expect(body.startsWith('No active runs.')).toBe(true);
    expect(body).toContain('Last: staleaaa  add-feature  aborted  30m ago');
  });
});
