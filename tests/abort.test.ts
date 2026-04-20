import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAbort } from '../src/commands/abort.js';
import {
  writeRunState,
  markActive,
  readRunState,
  activeMarker,
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

describe('runAbort', () => {
  let projectRoot: string;
  const pluginRoot = '/unused-plugin-root';

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(join(tmpdir(), 'ewh-abort-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('explicit <run-id>: marks aborted, clears ACTIVE, matches report --abort output', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'aaaaaaaa' }));
    await markActive(projectRoot, 'aaaaaaaa');

    const out = await runAbort({ projectRoot, pluginRoot, runId: 'aaaaaaaa' });
    expect(out).toContain('Run aaaaaaaa aborted.');

    const state = await readRunState(projectRoot, 'aaaaaaaa');
    expect(state.status).toBe('aborted');
    expect(await fileExists(activeMarker(projectRoot, 'aaaaaaaa'))).toBe(false);
  });

  it('explicit <run-id>: unknown id errors', async () => {
    await expect(
      runAbort({ projectRoot, pluginRoot, runId: 'missinggg' }),
    ).rejects.toThrow(/run not found: missinggg/);
  });

  it('explicit <run-id>: already-terminal run errors', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'donerun0', status: 'complete' }),
    );
    await expect(
      runAbort({ projectRoot, pluginRoot, runId: 'donerun0' }),
    ).rejects.toThrow(/already complete/);
  });

  it('omitted <run-id>: 0 active runs errors', async () => {
    await expect(runAbort({ projectRoot, pluginRoot })).rejects.toThrow(
      /no active run to abort/,
    );
  });

  it('omitted <run-id>: 0 active runs errors even if a terminal run exists', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'donerun1', status: 'complete' }),
    );
    await expect(runAbort({ projectRoot, pluginRoot })).rejects.toThrow(
      /no active run to abort/,
    );
  });

  it('omitted <run-id>: 1 active run → aborts it', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'onlyone0' }));
    await markActive(projectRoot, 'onlyone0');

    const out = await runAbort({ projectRoot, pluginRoot });
    expect(out).toContain('Run onlyone0 aborted.');

    const state = await readRunState(projectRoot, 'onlyone0');
    expect(state.status).toBe('aborted');
    expect(await fileExists(activeMarker(projectRoot, 'onlyone0'))).toBe(false);
  });

  it('omitted <run-id>: >1 active runs errors, lists IDs, suggests disambiguation', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'runaaaa1' }));
    await markActive(projectRoot, 'runaaaa1');
    await writeRunState(projectRoot, fakeRun({ run_id: 'runbbbb2' }));
    await markActive(projectRoot, 'runbbbb2');

    let msg = '';
    try {
      await runAbort({ projectRoot, pluginRoot });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/multiple active runs/);
    expect(msg).toContain('runaaaa1');
    expect(msg).toContain('runbbbb2');
    expect(msg).toContain('ewh abort <run-id>');

    // Neither run was mutated.
    expect((await readRunState(projectRoot, 'runaaaa1')).status).toBe('running');
    expect((await readRunState(projectRoot, 'runbbbb2')).status).toBe('running');
    expect(await fileExists(activeMarker(projectRoot, 'runaaaa1'))).toBe(true);
    expect(await fileExists(activeMarker(projectRoot, 'runbbbb2'))).toBe(true);
  });

  it('stale ACTIVE marker on terminal run is ignored for disambiguation', async () => {
    // Stale: terminal status but ACTIVE marker still present.
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'stale000', status: 'complete' }),
    );
    await markActive(projectRoot, 'stale000');
    // Live: running + ACTIVE.
    await writeRunState(projectRoot, fakeRun({ run_id: 'live0000' }));
    await markActive(projectRoot, 'live0000');

    const out = await runAbort({ projectRoot, pluginRoot });
    expect(out).toContain('Run live0000 aborted.');
    expect((await readRunState(projectRoot, 'stale000')).status).toBe('complete');
  });
});
