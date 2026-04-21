/**
 * Tests for pruneOldRuns (src/state/store.ts) and
 * readArtifactRetention (src/state/workflow-settings.ts).
 *
 * Five required cases:
 *   (a) cap is enforced — oldest runs deleted when count exceeds maxRuns
 *   (b) ACTIVE runs are never deleted
 *   (c) maxRuns === 'keep' skips pruning entirely
 *   (d) custom cap read from config (artifact_retention.max_runs)
 *   (e) corrupt/missing state.json falls back to epoch (pruned first) without throwing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneOldRuns } from '../src/state/store.js';
import { readArtifactRetention, writeEwhStateFile } from '../src/state/workflow-settings.js';
import { runStart } from '../src/commands/start.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-pruning-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeRunDir(
  projectRoot: string,
  runId: string,
  updatedAt: string,
  opts: { active?: boolean; corruptState?: boolean; missingState?: boolean } = {},
): Promise<string> {
  const dir = join(projectRoot, '.ewh-artifacts', `run-${runId}`);
  await fs.mkdir(dir, { recursive: true });

  if (!opts.missingState && !opts.corruptState) {
    await fs.writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ run_id: runId, updated_at: updatedAt }),
      'utf8',
    );
  } else if (opts.corruptState) {
    await fs.writeFile(join(dir, 'state.json'), 'not valid json!!!', 'utf8');
  }
  // missingState → no state.json at all

  if (opts.active) {
    await fs.writeFile(join(dir, 'ACTIVE'), `${process.pid}\n`, 'utf8');
  }

  return dir;
}

async function listRunDirs(projectRoot: string): Promise<string[]> {
  const artifactsDir = join(projectRoot, '.ewh-artifacts');
  try {
    const entries = await fs.readdir(artifactsDir);
    return entries.filter((e) => e.startsWith('run-'));
  } catch {
    return [];
  }
}

// ── (a) cap enforced ─────────────────────────────────────────────────────────

describe('pruneOldRuns — cap enforced', () => {
  it('deletes oldest runs when count exceeds maxRuns', async () => {
    // Create 5 runs with distinct timestamps
    await makeRunDir(tmpDir, 'old1', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'old2', '2024-01-02T00:00:00.000Z');
    await makeRunDir(tmpDir, 'mid3', '2024-06-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'new4', '2025-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'new5', '2025-06-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 3);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(3);
    // The two oldest should be gone
    expect(remaining).not.toContain('run-old1');
    expect(remaining).not.toContain('run-old2');
    // The three newest survive
    expect(remaining).toContain('run-mid3');
    expect(remaining).toContain('run-new4');
    expect(remaining).toContain('run-new5');
  });

  it('does nothing when run count is within the cap', async () => {
    await makeRunDir(tmpDir, 'r1', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r2', '2024-06-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 5);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(2);
  });

  it('deletes all runs when maxRuns is 0', async () => {
    await makeRunDir(tmpDir, 'r1', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r2', '2025-01-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 0);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(0);
  });
});

// ── (b) ACTIVE runs never deleted ────────────────────────────────────────────

describe('pruneOldRuns — ACTIVE runs skipped', () => {
  it('preserves an ACTIVE run even when it is oldest and cap is 1', async () => {
    await makeRunDir(tmpDir, 'active-old', '2020-01-01T00:00:00.000Z', { active: true });
    await makeRunDir(tmpDir, 'newer1', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'newer2', '2025-01-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 1);

    const remaining = await listRunDirs(tmpDir);
    // active-old preserved; one of the other two survives (newest = newer2)
    expect(remaining).toContain('run-active-old');
    expect(remaining).toContain('run-newer2');
    expect(remaining).not.toContain('run-newer1');
  });

  it('prunes a PID-stale run (dead PID in ACTIVE marker) when count exceeds cap', async () => {
    await makeRunDir(tmpDir, 'stale-old', '2020-01-01T00:00:00.000Z');
    await fs.writeFile(
      join(tmpDir, '.ewh-artifacts', 'run-stale-old', 'ACTIVE'),
      '-1\n',
      'utf8',
    );
    await makeRunDir(tmpDir, 'newer1', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'newer2', '2025-01-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 1);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toContain('run-newer2');
    expect(remaining).not.toContain('run-stale-old');
  });

  it('preserves all ACTIVE runs regardless of cap', async () => {
    await makeRunDir(tmpDir, 'a1', '2023-01-01T00:00:00.000Z', { active: true });
    await makeRunDir(tmpDir, 'a2', '2023-06-01T00:00:00.000Z', { active: true });
    await makeRunDir(tmpDir, 'old', '2022-01-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 0);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toContain('run-a1');
    expect(remaining).toContain('run-a2');
    expect(remaining).not.toContain('run-old');
  });
});

// ── (c) 'keep' skips pruning ─────────────────────────────────────────────────

describe("pruneOldRuns — 'keep' skips pruning", () => {
  it("returns immediately without deleting anything when maxRuns is 'keep'", async () => {
    await makeRunDir(tmpDir, 'r1', '2020-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r2', '2021-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r3', '2022-01-01T00:00:00.000Z');

    await pruneOldRuns(tmpDir, 'keep');

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(3);
  });

  it("does not throw when 'keep' is passed even if .ewh-artifacts is missing", async () => {
    // No artifacts dir — should not throw
    await expect(pruneOldRuns(tmpDir, 'keep')).resolves.toBeUndefined();
  });
});

// ── (d) custom cap from config ───────────────────────────────────────────────

describe('readArtifactRetention — custom cap from config', () => {
  it('returns the configured max_runs value', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      join(claudeDir, 'ewh-state.json'),
      JSON.stringify({ artifact_retention: { max_runs: 5 } }),
      'utf8',
    );

    const { maxRuns } = await readArtifactRetention(tmpDir);
    expect(maxRuns).toBe(5);
  });

  it("returns 'keep' when configured as 'keep'", async () => {
    const claudeDir = join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      join(claudeDir, 'ewh-state.json'),
      JSON.stringify({ artifact_retention: { max_runs: 'keep' } }),
      'utf8',
    );

    const { maxRuns } = await readArtifactRetention(tmpDir);
    expect(maxRuns).toBe('keep');
  });

  it('returns default of 10 when artifact_retention is absent from config', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      join(claudeDir, 'ewh-state.json'),
      JSON.stringify({ workflow_settings: {} }),
      'utf8',
    );

    const { maxRuns } = await readArtifactRetention(tmpDir);
    expect(maxRuns).toBe(10);
  });

  it('returns default of 10 when ewh-state.json does not exist', async () => {
    const { maxRuns } = await readArtifactRetention(tmpDir);
    expect(maxRuns).toBe(10);
  });

  it('integrates with pruneOldRuns using custom cap', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      join(claudeDir, 'ewh-state.json'),
      JSON.stringify({ artifact_retention: { max_runs: 2 } }),
      'utf8',
    );

    await makeRunDir(tmpDir, 'r1', '2023-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r2', '2024-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'r3', '2025-01-01T00:00:00.000Z');

    const { maxRuns } = await readArtifactRetention(tmpDir);
    await pruneOldRuns(tmpDir, maxRuns);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain('run-r2');
    expect(remaining).toContain('run-r3');
    expect(remaining).not.toContain('run-r1');
  });
});

// ── (e) corrupt/missing state.json falls back without throwing ────────────────

describe('pruneOldRuns — corrupt or missing state.json', () => {
  it('does not throw when state.json contains invalid JSON', async () => {
    await makeRunDir(tmpDir, 'good', '2025-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'corrupt', '2025-01-01T00:00:00.000Z', { corruptState: true });

    await expect(pruneOldRuns(tmpDir, 5)).resolves.toBeUndefined();
  });

  it('does not throw when state.json is missing', async () => {
    await makeRunDir(tmpDir, 'good', '2025-01-01T00:00:00.000Z');
    await makeRunDir(tmpDir, 'nostate', '2025-01-01T00:00:00.000Z', { missingState: true });

    await expect(pruneOldRuns(tmpDir, 5)).resolves.toBeUndefined();
  });

  it('uses mtime for corrupt state.json so a recent-but-corrupt run survives over an older good run', async () => {
    // 'old-good' has a 2023 JSON timestamp; 'corrupt' has its directory mtime
    // pinned to 2030 so the test does not depend on wall-clock time.
    await makeRunDir(tmpDir, 'old-good', '2023-01-01T00:00:00.000Z');
    const corruptDir = await makeRunDir(tmpDir, 'corrupt', '2025-01-01T00:00:00.000Z', { corruptState: true });
    const pinned = new Date('2030-01-01T00:00:00.000Z');
    await fs.utimes(corruptDir, pinned, pinned);

    await pruneOldRuns(tmpDir, 1);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining).toContain('run-corrupt');
    expect(remaining).not.toContain('run-old-good');
  });

  it('uses mtime for missing state.json so a recent-but-missing run survives over an older good run', async () => {
    // mtime pinned to 2030 so wall-clock drift cannot flip the result.
    await makeRunDir(tmpDir, 'old-good', '2023-01-01T00:00:00.000Z');
    const nostateDir = await makeRunDir(tmpDir, 'nostate', '2025-01-01T00:00:00.000Z', { missingState: true });
    const pinned = new Date('2030-01-01T00:00:00.000Z');
    await fs.utimes(nostateDir, pinned, pinned);

    await pruneOldRuns(tmpDir, 1);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining).toContain('run-nostate');
    expect(remaining).not.toContain('run-old-good');
  });

  it('falls back to epoch when corrupt state and stat both fail (older mtime loses to good run)', async () => {
    // pin mtime to 1970 so old-good wins even though corrupt has no JSON.
    await makeRunDir(tmpDir, 'old-good', '2023-01-01T00:00:00.000Z');
    const corruptDir = await makeRunDir(tmpDir, 'corrupt', '2025-01-01T00:00:00.000Z', { corruptState: true });
    const pinned = new Date('1970-01-01T00:00:00.000Z');
    await fs.utimes(corruptDir, pinned, pinned);

    await pruneOldRuns(tmpDir, 1);

    const remaining = await listRunDirs(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining).toContain('run-old-good');
    expect(remaining).not.toContain('run-corrupt');
  });

  it('does not throw when .ewh-artifacts directory is absent', async () => {
    // No artifacts dir at all — readdir fails → function returns early
    await expect(pruneOldRuns(tmpDir, 3)).resolves.toBeUndefined();
  });
});

// ── (f) atomicWriteStateFile fsyncs before rename ────────────────────────────

describe('atomicWriteStateFile — durability', () => {
  it('calls fh.sync() on the tmp file before rename', async () => {
    const realOpen = fs.open.bind(fs);
    let syncCount = 0;
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockImplementation((async (path: string, flags?: string | number) => {
        const fh = await realOpen(path as never, flags as never);
        const realSync = fh.sync.bind(fh);
        fh.sync = async () => {
          syncCount += 1;
          await realSync();
        };
        return fh;
      }) as unknown as typeof fs.open);

    try {
      await writeEwhStateFile(tmpDir, { artifact_retention: { max_runs: 7 } });
    } finally {
      openSpy.mockRestore();
    }

    expect(syncCount).toBeGreaterThanOrEqual(1);
    const written = await fs.readFile(join(tmpDir, '.claude', 'ewh-state.json'), 'utf8');
    expect(JSON.parse(written)).toEqual({ artifact_retention: { max_runs: 7 } });
  });
});

// ── (g) runStart wires pruneOldRuns ──────────────────────────────────────────

describe('runStart → pruneOldRuns wiring', () => {
  it('prunes old runs at the start of runStart using configured retention', async () => {
    // Configure cap = 0 so all pre-existing non-ACTIVE runs are pruned at start.
    await writeEwhStateFile(tmpDir, { artifact_retention: { max_runs: 0 } });
    // Seed two old, non-ACTIVE runs.
    await fs.mkdir(join(tmpDir, '.ewh-artifacts', 'run-old1'), { recursive: true });
    await fs.writeFile(
      join(tmpDir, '.ewh-artifacts', 'run-old1', 'state.json'),
      JSON.stringify({ run_id: 'old1', updated_at: '2023-01-01T00:00:00.000Z' }),
      'utf8',
    );
    await fs.mkdir(join(tmpDir, '.ewh-artifacts', 'run-old2'), { recursive: true });
    await fs.writeFile(
      join(tmpDir, '.ewh-artifacts', 'run-old2', 'state.json'),
      JSON.stringify({ run_id: 'old2', updated_at: '2024-01-01T00:00:00.000Z' }),
      'utf8',
    );

    // Minimal plugin root for `list` subcommand.
    const pluginRoot = join(tmpDir, 'plugin');
    await fs.mkdir(join(pluginRoot, 'skills', 'doit'), { recursive: true });

    await runStart({
      projectRoot: tmpDir,
      pluginRoot,
      rawArgv: 'list',
    });

    const seededLeft = (await listRunDirs(tmpDir)).filter(
      (n) => n === 'run-old1' || n === 'run-old2',
    );
    expect(seededLeft).toEqual([]);
  });
});
