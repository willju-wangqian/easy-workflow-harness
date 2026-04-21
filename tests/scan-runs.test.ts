import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  scanRuns,
  writeRunState,
  markActive,
  clearActive,
  runDir,
} from '../src/state/store.js';
import type { RunState } from '../src/state/types.js';

function fakeRun(overrides: Partial<RunState>): RunState {
  const now = new Date().toISOString();
  return {
    run_id: 'deadbeef',
    workflow: 'add-feature',
    raw_argv: 'add-feature "test"',
    current_step_index: 0,
    steps: [
      { name: 'plan', gate: 'auto', state: { phase: 'pending' } },
      { name: 'impl', gate: 'auto', state: { phase: 'pending' } },
    ],
    started_at: now,
    updated_at: now,
    status: 'running',
    ...overrides,
  };
}

describe('scanRuns', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(join(tmpdir(), 'ewh-scan-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('returns [] when .ewh-artifacts missing', async () => {
    expect(await scanRuns(projectRoot)).toEqual([]);
  });

  it('returns [] when .ewh-artifacts empty', async () => {
    await fs.mkdir(join(projectRoot, '.ewh-artifacts'), { recursive: true });
    expect(await scanRuns(projectRoot)).toEqual([]);
  });

  it('reports a single running run with ACTIVE marker', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'aaaaaaaa' }));
    await markActive(projectRoot, 'aaaaaaaa');
    const runs = await scanRuns(projectRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run_id: 'aaaaaaaa',
      workflow: 'add-feature',
      status: 'running',
      current_step_index: 0,
      total_steps: 2,
      current_phase: 'pending',
      is_active: true,
    });
  });

  it('marks is_active=false when ACTIVE absent', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'bbbbbbbb', status: 'complete' }));
    const runs = await scanRuns(projectRoot);
    expect(runs[0]!.is_active).toBe(false);
    expect(runs[0]!.status).toBe('complete');
  });

  it('sorts active+running before terminal runs; then updated_at desc', async () => {
    const older = '2026-01-01T00:00:00.000Z';
    const mid = '2026-02-01T00:00:00.000Z';
    const newer = '2026-03-01T00:00:00.000Z';

    await writeRunState(projectRoot, fakeRun({ run_id: 'old-term', status: 'complete', updated_at: older }));
    await writeRunState(projectRoot, fakeRun({ run_id: 'new-term', status: 'complete', updated_at: newer }));
    await writeRunState(projectRoot, fakeRun({ run_id: 'active11', status: 'running', updated_at: mid }));
    await markActive(projectRoot, 'active11');
    // overwrite updated_at since writeRunState bumps it
    const st = JSON.parse(await fs.readFile(join(projectRoot, '.ewh-artifacts/run-old-term/state.json'), 'utf8'));
    st.updated_at = older;
    await fs.writeFile(join(projectRoot, '.ewh-artifacts/run-old-term/state.json'), JSON.stringify(st));
    const st2 = JSON.parse(await fs.readFile(join(projectRoot, '.ewh-artifacts/run-new-term/state.json'), 'utf8'));
    st2.updated_at = newer;
    await fs.writeFile(join(projectRoot, '.ewh-artifacts/run-new-term/state.json'), JSON.stringify(st2));
    const st3 = JSON.parse(await fs.readFile(join(projectRoot, '.ewh-artifacts/run-active11/state.json'), 'utf8'));
    st3.updated_at = mid;
    await fs.writeFile(join(projectRoot, '.ewh-artifacts/run-active11/state.json'), JSON.stringify(st3));

    const runs = await scanRuns(projectRoot);
    expect(runs.map((r) => r.run_id)).toEqual(['active11', 'new-term', 'old-term']);
  });

  it('treats stale ACTIVE (terminal state) as not-active for sort purposes', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'staleaaa', status: 'complete' }));
    await markActive(projectRoot, 'staleaaa');
    await writeRunState(projectRoot, fakeRun({ run_id: 'liveaaaa', status: 'running' }));
    await markActive(projectRoot, 'liveaaaa');
    const runs = await scanRuns(projectRoot);
    expect(runs[0]!.run_id).toBe('liveaaaa');
    // stale still appears with is_active=true but status=complete
    const stale = runs.find((r) => r.run_id === 'staleaaa')!;
    expect(stale.is_active).toBe(true);
    expect(stale.status).toBe('complete');
  });

  it('skips malformed state.json with stderr warning', async () => {
    const bad = runDir(projectRoot, 'badbadba');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(join(bad, 'state.json'), 'not-json-{{{');
    await writeRunState(projectRoot, fakeRun({ run_id: 'goodgood' }));
    const errors: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      errors.push(msg);
      return true;
    }) as typeof process.stderr.write;
    try {
      const runs = await scanRuns(projectRoot);
      expect(runs.map((r) => r.run_id)).toEqual(['goodgood']);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(errors.some((e) => e.includes('unreadable'))).toBe(true);
  });

  it('PID-stale run: is_stale=true, is_active=false, ACTIVE marker auto-cleared', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'staleid1', status: 'running' }));
    const markerPath = join(runDir(projectRoot, 'staleid1'), 'ACTIVE');
    await fs.writeFile(markerPath, '-1\n', 'utf8'); // -1 is always an invalid/dead PID
    const runs = await scanRuns(projectRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run_id: 'staleid1',
      is_active: false,
      is_stale: true,
      status: 'running',
    });
    await expect(fs.access(markerPath)).rejects.toThrow(); // auto-cleared
  });

  it('subcommand run: current_phase has no subcommand: prefix', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'subcmd01', subcommand: 'cleanup', steps: [] }));
    const runs = await scanRuns(projectRoot);
    expect(runs[0]!.current_phase).toBe('cleanup');
  });

  it('age-stale run: live PID + running + updated_at > 48h → is_stale=true, ACTIVE cleared', async () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const oldTs = '2026-04-19T11:59:00Z'; // 48h01m before now
    await writeRunState(projectRoot, fakeRun({ run_id: 'agestat1', status: 'running' }));
    const stPath = join(runDir(projectRoot, 'agestat1'), 'state.json');
    const st = JSON.parse(await fs.readFile(stPath, 'utf8'));
    st.updated_at = oldTs;
    await fs.writeFile(stPath, JSON.stringify(st));
    const markerPath = join(runDir(projectRoot, 'agestat1'), 'ACTIVE');
    await fs.writeFile(markerPath, `${process.pid}\n`, 'utf8');
    const runs = await scanRuns(projectRoot, now);
    expect(runs[0]).toMatchObject({ run_id: 'agestat1', is_stale: true, is_active: false });
    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  it('age-fresh run: live PID + running + updated_at < 48h → is_active=true', async () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const recentTs = '2026-04-20T13:00:00Z'; // 23h before now
    await writeRunState(projectRoot, fakeRun({ run_id: 'agefr001', status: 'running' }));
    const stPath = join(runDir(projectRoot, 'agefr001'), 'state.json');
    const st = JSON.parse(await fs.readFile(stPath, 'utf8'));
    st.updated_at = recentTs;
    await fs.writeFile(stPath, JSON.stringify(st));
    const markerPath = join(runDir(projectRoot, 'agefr001'), 'ACTIVE');
    await fs.writeFile(markerPath, `${process.pid}\n`, 'utf8');
    const runs = await scanRuns(projectRoot, now);
    expect(runs[0]).toMatchObject({ run_id: 'agefr001', is_active: true, is_stale: false });
    await expect(fs.access(markerPath)).resolves.toBeUndefined();
  });

  it('ignores non-run-* entries in .ewh-artifacts', async () => {
    await fs.mkdir(join(projectRoot, '.ewh-artifacts'), { recursive: true });
    await fs.writeFile(join(projectRoot, '.ewh-artifacts', 'scratch.txt'), 'x');
    await fs.mkdir(join(projectRoot, '.ewh-artifacts', 'notes'), { recursive: true });
    await writeRunState(projectRoot, fakeRun({ run_id: 'realrun1' }));
    const runs = await scanRuns(projectRoot);
    expect(runs.map((r) => r.run_id)).toEqual(['realrun1']);
  });
});
