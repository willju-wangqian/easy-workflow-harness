import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CHUNK_SIZE,
  enumerateFiles,
  parsePatternsContent,
  splitIntoChunks,
} from '../src/chunking/plan.js';
import {
  INCREMENTAL_ANCHOR,
  mergeChunkArtifacts,
  writeIncrementalAnchor,
} from '../src/chunking/merge.js';
import {
  readChunkedPatterns,
  writeChunkedPatterns,
} from '../src/state/workflow-settings.js';
import { transitionStep, type TransitionOpts } from '../src/state/machine.js';
import { SENTINEL } from '../src/state/sentinel.js';
import type { RunState, Step } from '../src/state/types.js';

let tmpDir: string;
let opts: TransitionOpts;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-chunk-test-'));
  await fs.mkdir(join(tmpDir, 'agents'), { recursive: true });
  await fs.mkdir(join(tmpDir, 'rules'), { recursive: true });
  await fs.writeFile(
    join(tmpDir, 'agents', 'scanner.md'),
    '---\nname: scanner\nmodel: haiku\ntools: [Read, Write]\n---\n\nScanner agent body.',
    'utf8',
  );
  await fs.writeFile(
    join(tmpDir, 'agents', 'scanner-inc.md'),
    '---\nname: scanner-inc\nmodel: haiku\ntools: [Read, Edit]\nincremental: true\n---\n\nIncremental scanner body.',
    'utf8',
  );
  opts = { pluginRoot: tmpDir, projectRoot: tmpDir };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(steps: Step[]): RunState {
  return {
    run_id: 'ck01',
    workflow: 'scan',
    raw_argv: 'scan',
    current_step_index: 0,
    steps,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
  };
}

function makeChunkedStep(overrides?: Partial<Step>): Step {
  return {
    name: 'scan',
    gate: 'auto',
    agent: 'scanner',
    chunked: true,
    artifact: 'scan-findings.md',
    description: 'Scan files for TODOs.',
    state: { phase: 'pending' },
    ...overrides,
  };
}

describe('plan.parsePatternsContent', () => {
  it('accepts { include, exclude }', () => {
    const out = parsePatternsContent('{"include":["src/**/*.ts"],"exclude":["**/tmp/**"]}');
    expect(out.include).toEqual(['src/**/*.ts']);
    expect(out.exclude).toEqual(['**/tmp/**']);
  });

  it('accepts include-only', () => {
    const out = parsePatternsContent('{"include":["a","b"]}');
    expect(out.include).toEqual(['a', 'b']);
    expect(out.exclude).toBeUndefined();
  });

  it('accepts bare array', () => {
    const out = parsePatternsContent('["src/**/*.ts","tests/**/*.ts"]');
    expect(out.include).toEqual(['src/**/*.ts', 'tests/**/*.ts']);
  });

  it('rejects empty content', () => {
    expect(() => parsePatternsContent('   ')).toThrow(/empty/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parsePatternsContent('{not json}')).toThrow(/JSON/);
  });

  it('rejects empty include', () => {
    expect(() => parsePatternsContent('{"include":[]}')).toThrow(/non-empty/);
  });
});

describe('plan.splitIntoChunks', () => {
  it('splits an array into fixed-size chunks', () => {
    const chunks = splitIntoChunks(['a', 'b', 'c', 'd', 'e'], 2);
    expect(chunks).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('uses the default chunk size', () => {
    const files = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const chunks = splitIntoChunks(files);
    expect(chunks.length).toBe(Math.ceil(20 / DEFAULT_CHUNK_SIZE));
    expect(chunks[0]!.length).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('returns [] for empty input', () => {
    expect(splitIntoChunks([])).toEqual([]);
  });

  it('throws on non-positive chunk size', () => {
    expect(() => splitIntoChunks(['a'], 0)).toThrow(/> 0/);
  });
});

describe('plan.enumerateFiles', () => {
  it('finds files matching include and honours exclude', async () => {
    await fs.mkdir(join(tmpDir, 'src', 'sub'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'src', 'a.ts'), '', 'utf8');
    await fs.writeFile(join(tmpDir, 'src', 'sub', 'b.ts'), '', 'utf8');
    await fs.writeFile(join(tmpDir, 'src', 'skip.md'), '', 'utf8');

    const files = await enumerateFiles(
      { include: ['src/**/*.ts'], exclude: ['**/sub/**'] },
      tmpDir,
    );
    expect(files).toEqual(['src/a.ts']);
  });

  it('returns [] when include is empty', async () => {
    const files = await enumerateFiles({ include: [] }, tmpDir);
    expect(files).toEqual([]);
  });
});

describe('merge.mergeChunkArtifacts', () => {
  it('concatenates present chunks and stubs missing ones', async () => {
    const cpaths = [
      join(tmpDir, 'c1.md'),
      join(tmpDir, 'c2.md'),
      join(tmpDir, 'c3.md'),
    ];
    await fs.writeFile(cpaths[0]!, 'finding-A\n', 'utf8');
    await fs.writeFile(cpaths[2]!, 'finding-C\n', 'utf8');
    const result = await mergeChunkArtifacts({
      chunkArtifactPaths: cpaths,
      targetArtifact: 'out.md',
      projectRoot: tmpDir,
      incremental: false,
    });
    expect(result.present).toBe(2);
    expect(result.missing).toBe(1);
    const body = await fs.readFile(join(tmpDir, 'out.md'), 'utf8');
    expect(body).toContain('finding-A');
    expect(body).toContain('finding-C');
    expect(body).toContain('no output on disk');
  });

  it('strips the anchor from incremental chunks', async () => {
    const cpath = join(tmpDir, 'c1.md');
    await writeIncrementalAnchor(cpath, '# header');
    const existing = await fs.readFile(cpath, 'utf8');
    expect(existing).toContain(INCREMENTAL_ANCHOR);
    // Simulate the agent having appended a finding before the anchor.
    await fs.writeFile(
      cpath,
      `# header\n\n- finding-X\n\n${INCREMENTAL_ANCHOR}\n`,
      'utf8',
    );
    const result = await mergeChunkArtifacts({
      chunkArtifactPaths: [cpath],
      targetArtifact: 'out-inc.md',
      projectRoot: tmpDir,
      incremental: true,
    });
    expect(result.present).toBe(1);
    const body = await fs.readFile(join(tmpDir, 'out-inc.md'), 'utf8');
    expect(body).toContain('finding-X');
    expect(body).not.toContain(INCREMENTAL_ANCHOR);
  });
});

describe('chunked_patterns persistence', () => {
  it('round-trips through .claude/ewh-state.json', async () => {
    expect(await readChunkedPatterns(tmpDir, 'scan', 'scan-step')).toBeNull();
    await writeChunkedPatterns(tmpDir, 'scan', 'scan-step', {
      include: ['src/**/*.ts'],
      exclude: ['**/node_modules/**'],
    });
    const out = await readChunkedPatterns(tmpDir, 'scan', 'scan-step');
    expect(out).toEqual({
      include: ['src/**/*.ts'],
      exclude: ['**/node_modules/**'],
    });
  });

  it('coexists with workflow_settings in the same file', async () => {
    const { writeWorkflowSettings } = await import(
      '../src/state/workflow-settings.js'
    );
    await writeWorkflowSettings(tmpDir, 'scan', { auto_structural: true });
    await writeChunkedPatterns(tmpDir, 'scan', 'step-a', { include: ['x'] });
    const raw = JSON.parse(
      await fs.readFile(join(tmpDir, '.claude', 'ewh-state.json'), 'utf8'),
    );
    expect(raw.workflow_settings?.scan?.auto_structural).toBe(true);
    expect(raw.chunked_patterns?.['scan/step-a']).toEqual({ include: ['x'] });
  });
});

// ── chunk_plan → chunk_running transitions ──────────────────────────────────

describe('pending → chunk_plan (no cached patterns)', () => {
  it('emits user-prompt for patterns and creates an example file', async () => {
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('chunk_plan');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('glob patterns');
    expect(result.instruction.report_with).toContain('--result');

    const patternsPath = join(
      tmpDir,
      '.ewh-artifacts',
      'run-ck01',
      'step-0-chunk-patterns.json',
    );
    const body = await fs.readFile(patternsPath, 'utf8');
    expect(body).toContain('include');
  });
});

describe('pending → chunk_running (cached patterns short-circuit)', () => {
  it('skips the user prompt when patterns are cached', async () => {
    await fs.writeFile(join(tmpDir, 'a.ts'), '', 'utf8');
    await fs.writeFile(join(tmpDir, 'b.ts'), '', 'utf8');
    await writeChunkedPatterns(tmpDir, 'scan', 'scan', {
      include: ['*.ts'],
    });
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('chunk_running');
    expect(result.instruction.kind).toBe('tool-call');
    if (result.next.phase === 'chunk_running') {
      expect(result.next.total).toBe(1);
      expect(result.next.chunks[0]).toEqual(['a.ts', 'b.ts']);
    }
  });
});

describe('chunk_plan → chunk_running via --result', () => {
  it('reads patterns file, persists them, and enumerates files', async () => {
    await fs.writeFile(join(tmpDir, 'x.ts'), '', 'utf8');
    const step = makeChunkedStep();
    const run = makeRun([step]);

    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    const patternsPath = join(
      tmpDir,
      '.ewh-artifacts',
      'run-ck01',
      'step-0-chunk-patterns.json',
    );
    await fs.writeFile(patternsPath, JSON.stringify({ include: ['*.ts'] }), 'utf8');

    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: patternsPath },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_running');

    const persisted = await readChunkedPatterns(tmpDir, 'scan', 'scan');
    expect(persisted?.include).toEqual(['*.ts']);
  });

  it('stays in chunk_plan on invalid JSON', async () => {
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    const patternsPath = join(
      tmpDir,
      '.ewh-artifacts',
      'run-ck01',
      'step-0-chunk-patterns.json',
    );
    await fs.writeFile(patternsPath, 'not-json', 'utf8');
    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: patternsPath },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_plan');
    expect(result.instruction.body).toContain('invalid');
  });

  it('stays in chunk_plan when the patterns file is missing', async () => {
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;

    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: {
          kind: 'result',
          step_index: 0,
          result_path: join(tmpDir, 'does-not-exist.json'),
        },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_plan');
    expect(result.instruction.body).toContain('cannot read patterns');
  });
});

describe('chunk_running → chunk_merge loop', () => {
  async function setupTwoChunks() {
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(join(tmpDir, `f${i}.ts`), '', 'utf8');
    }
    await writeChunkedPatterns(tmpDir, 'scan', 'scan', { include: ['*.ts'] });
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r.next;
    return { step, run };
  }

  it('advances chunk_index per result and merges on the last', async () => {
    const { step, run } = await setupTwoChunks();
    if (step.state.phase !== 'chunk_running') throw new Error('expected chunk_running');
    expect(step.state.total).toBe(2);
    expect(step.state.chunk_index).toBe(0);

    // Report chunk 1 result: write sentinel output, mark chunk artifact.
    const out1 = step.state.chunk_result_paths[0]!;
    const art1 = step.state.chunk_artifact_paths[0]!;
    await fs.writeFile(out1, `chunk 1 done\n${SENTINEL}\n`, 'utf8');
    await fs.writeFile(art1, 'finding-1\n', 'utf8');

    const r1 = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: out1 } },
      run,
      opts,
    );
    expect(r1.next.phase).toBe('chunk_running');
    step.state = r1.next;
    if (step.state.phase !== 'chunk_running') throw new Error('expected chunk_running');
    expect(step.state.chunk_index).toBe(1);
    expect(step.state.completed[0]).toBe(true);

    // Chunk 2 → triggers merge → complete.
    const out2 = step.state.chunk_result_paths[1]!;
    const art2 = step.state.chunk_artifact_paths[1]!;
    await fs.writeFile(out2, `chunk 2 done\n${SENTINEL}\n`, 'utf8');
    await fs.writeFile(art2, 'finding-2\n', 'utf8');
    const r2 = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: out2 } },
      run,
      opts,
    );
    expect(r2.next.phase).toBe('complete');
    const merged = await fs.readFile(join(tmpDir, 'scan-findings.md'), 'utf8');
    expect(merged).toContain('finding-1');
    expect(merged).toContain('finding-2');
  });

  it('gates on chunk error when retries exhausted', async () => {
    const { step, run } = await setupTwoChunks();
    if (step.state.phase !== 'chunk_running') throw new Error();
    // Pre-exhaust retries so one more error gates.
    step.state.retries[0] = 5;
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'boom' } },
      run,
      { ...opts, maxErrorRetries: 1 },
    );
    expect(result.next.phase).toBe('chunk_running');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('failed after');
  });

  it('retries on chunk error when under the retry cap', async () => {
    const { step, run } = await setupTwoChunks();
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'transient' } },
      run,
      { ...opts, maxErrorRetries: 3 },
    );
    expect(result.next.phase).toBe('chunk_running');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('[retry]');
  });

  it('stays in chunk_running if chunk result lacks the sentinel', async () => {
    const { step, run } = await setupTwoChunks();
    if (step.state.phase !== 'chunk_running') throw new Error();
    const out1 = step.state.chunk_result_paths[0]!;
    await fs.writeFile(out1, 'missing sentinel', 'utf8');
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: out1 } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_running');
    expect(result.instruction.body).toContain('AGENT_COMPLETE');
  });

  it('skips a chunk on decision=no (gate after error)', async () => {
    const { step, run } = await setupTwoChunks();
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    // Should advance to chunk 2.
    expect(result.next.phase).toBe('chunk_running');
    if (result.next.phase === 'chunk_running') {
      expect(result.next.chunk_index).toBe(1);
    }
  });

  it('re-emits the current chunk instruction on enter (crash recovery)', async () => {
    const { step, run } = await setupTwoChunks();
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('chunk_running');
    expect(result.instruction.kind).toBe('tool-call');
  });
});

describe('pending → skipped (no files matched)', () => {
  it('short-circuits to skipped when patterns match nothing', async () => {
    await writeChunkedPatterns(tmpDir, 'scan', 'scan', { include: ['*.xyz'] });
    const step = makeChunkedStep();
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('skipped');
  });
});

describe('incremental agent: pre-creates anchor', () => {
  it('writes anchor to each chunk artifact before dispatch', async () => {
    await fs.writeFile(join(tmpDir, 'a.ts'), '', 'utf8');
    await fs.writeFile(join(tmpDir, 'b.ts'), '', 'utf8');
    await writeChunkedPatterns(tmpDir, 'scan', 'scan', { include: ['*.ts'] });
    const step = makeChunkedStep({ agent: 'scanner-inc' });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('chunk_running');
    if (r.next.phase !== 'chunk_running') return;
    expect(r.next.incremental).toBe(true);
    const art0 = r.next.chunk_artifact_paths[0]!;
    const body = await fs.readFile(art0, 'utf8');
    expect(body).toContain(INCREMENTAL_ANCHOR);
  });
});
