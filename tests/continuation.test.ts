import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transitionStep, type TransitionOpts } from '../src/state/machine.js';
import { SENTINEL } from '../src/state/sentinel.js';
import type { RunState, SplitChunk, Step, StepState } from '../src/state/types.js';

let tmpDir: string;
let opts: TransitionOpts;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-continuation-test-'));
  await fs.mkdir(join(tmpDir, 'agents'), { recursive: true });
  await fs.mkdir(join(tmpDir, 'rules'), { recursive: true });
  await fs.writeFile(
    join(tmpDir, 'agents', 'hello.md'),
    '---\nname: hello\nmodel: haiku\ntools: [Write]\n---\n\nAgent body.',
    'utf8',
  );
  opts = { pluginRoot: tmpDir, projectRoot: tmpDir };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(steps: Step[], stepIndex = 0): RunState {
  return {
    run_id: 'r01',
    workflow: 'hello',
    raw_argv: 'hello',
    current_step_index: stepIndex,
    steps,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
  };
}

/** Non-scriptable step (has reads) to bypass script_propose. */
function makeStep(overrides?: Partial<Step>): Step {
  return {
    name: 'greet',
    gate: 'auto',
    description: 'Write greeting.',
    reads: ['_nonscriptable'],
    state: { phase: 'pending' },
    ...overrides,
  };
}

async function enterAgentRunState(step: Step, run: RunState): Promise<void> {
  const r = await transitionStep(step, { kind: 'enter' }, run, opts);
  step.state = r.next;
}

/** Create an on-disk run dir with an original prompt file. Returns rdPath. */
async function makeRunDir(runId = 'r01'): Promise<string> {
  const rdPath = join(tmpDir, '.ewh-artifacts', runId);
  await fs.mkdir(rdPath, { recursive: true });
  return rdPath;
}

// ── §6c: agent_run → continuation ─────────────────────────────────────────

describe('agent_run → continuation (sentinel missing)', () => {
  it('transitions to continuation and emits tool-call', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, 'Partial work, no sentinel.', 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );

    expect(result.next.phase).toBe('continuation');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('continuation');
    expect(result.instruction.report_with).toContain('--result');

    if (result.next.phase === 'continuation') {
      const exists = await fs
        .access(result.next.continuation_prompt_path)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
  });

  it('continuation prompt contains the partial output', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, 'My partial work here.', 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );

    if (result.next.phase !== 'continuation') throw new Error('expected continuation');
    const promptContent = await fs.readFile(result.next.continuation_prompt_path, 'utf8');
    expect(promptContent).toContain('My partial work here.');
    expect(promptContent).toContain('Continuation Context');
  });
});

// ── §6c: continuation crash recovery ──────────────────────────────────────

describe('continuation crash recovery (enter event)', () => {
  it('re-emits the continuation tool-call', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();
    const contPromptPath = join(rdPath, 'step-0-continuation-prompt.md');
    const contResultPath = join(rdPath, 'step-0-continuation-output.md');
    await fs.writeFile(contPromptPath, 'Continuation prompt.', 'utf8');

    step.state = {
      phase: 'continuation',
      partial_path: join(rdPath, 'step-0-output.md'),
      original_prompt_path: join(rdPath, 'step-0-prompt.md'),
      continuation_prompt_path: contPromptPath,
      continuation_result_path: contResultPath,
      rules: [],
    };

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('continuation');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.report_with).toContain(contResultPath);
  });
});

// ── §6c: continuation → artifact_verify/complete ──────────────────────────

describe('continuation → complete (sentinel present)', () => {
  it('completes when continuation result has sentinel and no artifact', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const originalPromptPath = join(rdPath, 'step-0-prompt.md');
    const contPromptPath = join(rdPath, 'step-0-continuation-prompt.md');
    const contResultPath = join(rdPath, 'step-0-continuation-output.md');
    await fs.writeFile(originalPromptPath, 'Original prompt.', 'utf8');
    await fs.writeFile(contPromptPath, 'Continuation prompt.', 'utf8');
    await fs.writeFile(contResultPath, `All done.\n${SENTINEL}\n`, 'utf8');

    step.state = {
      phase: 'continuation',
      partial_path: join(rdPath, 'step-0-output.md'),
      original_prompt_path: originalPromptPath,
      continuation_prompt_path: contPromptPath,
      continuation_result_path: contResultPath,
      rules: [],
    };

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: contResultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });
});

// ── §6a: continuation → split ─────────────────────────────────────────────

describe('continuation → split (still missing sentinel)', () => {
  it('escalates to split when continuation result also lacks sentinel', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const originalPromptPath = join(rdPath, 'step-0-prompt.md');
    const partialPath = join(rdPath, 'step-0-output.md');
    const contPromptPath = join(rdPath, 'step-0-continuation-prompt.md');
    const contResultPath = join(rdPath, 'step-0-continuation-output.md');
    await fs.writeFile(originalPromptPath, 'Original prompt.', 'utf8');
    await fs.writeFile(partialPath, '1. item one\n2. item two\n3. item three\n', 'utf8');
    await fs.writeFile(contPromptPath, 'Continuation prompt.', 'utf8');
    await fs.writeFile(contResultPath, 'Still partial.', 'utf8');

    step.state = {
      phase: 'continuation',
      partial_path: partialPath,
      original_prompt_path: originalPromptPath,
      continuation_prompt_path: contPromptPath,
      continuation_result_path: contResultPath,
      rules: [],
    };

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: contResultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    expect(result.instruction.kind).toBe('tool-call');
    if (result.next.phase === 'split') {
      expect(result.next.chunks.length).toBeGreaterThan(0);
      expect(result.next.current_chunk_index).toBe(0);
    }
  });

  it('escalates to split on continuation error report', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const originalPromptPath = join(rdPath, 'step-0-prompt.md');
    const partialPath = join(rdPath, 'step-0-output.md');
    const contPromptPath = join(rdPath, 'step-0-continuation-prompt.md');
    const contResultPath = join(rdPath, 'step-0-continuation-output.md');
    await fs.writeFile(originalPromptPath, 'Original prompt.', 'utf8');
    await fs.writeFile(partialPath, '', 'utf8');
    await fs.writeFile(contPromptPath, 'Continuation prompt.', 'utf8');

    step.state = {
      phase: 'continuation',
      partial_path: partialPath,
      original_prompt_path: originalPromptPath,
      continuation_prompt_path: contPromptPath,
      continuation_result_path: contResultPath,
      rules: [],
    };

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'agent crashed' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
  });

  it('detected list items become split chunk items', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const originalPromptPath = join(rdPath, 'step-0-prompt.md');
    const partialPath = join(rdPath, 'step-0-output.md');
    const contPromptPath = join(rdPath, 'step-0-continuation-prompt.md');
    const contResultPath = join(rdPath, 'step-0-continuation-output.md');
    await fs.writeFile(originalPromptPath, 'Original prompt.', 'utf8');
    // 35 items → 2 chunks when DEFAULT_SPLIT_SIZE=30
    const items = Array.from({ length: 35 }, (_, i) => `- item-${i + 1}`).join('\n');
    await fs.writeFile(partialPath, items, 'utf8');
    await fs.writeFile(contPromptPath, 'Continuation prompt.', 'utf8');
    await fs.writeFile(contResultPath, 'Still partial.', 'utf8');

    step.state = {
      phase: 'continuation',
      partial_path: partialPath,
      original_prompt_path: originalPromptPath,
      continuation_prompt_path: contPromptPath,
      continuation_result_path: contResultPath,
      rules: [],
    };

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: contResultPath } },
      run,
      opts,
    );
    if (result.next.phase !== 'split') throw new Error('expected split');
    expect(result.next.chunks.length).toBe(2);
    expect(result.next.chunks[0]!.items.length).toBe(30);
    expect(result.next.chunks[1]!.items.length).toBe(5);
  });
});

// ── §6a: split dispatch loop ───────────────────────────────────────────────

async function makeSplitState(
  run: RunState,
  numChunks: number,
): Promise<Extract<StepState, { phase: 'split' }>> {
  const rdPath = await makeRunDir(run.run_id);
  const originalPromptPath = join(rdPath, 'step-0-prompt.md');
  await fs.writeFile(originalPromptPath, 'Original prompt.', 'utf8');

  const chunks: SplitChunk[] = [];
  for (let i = 0; i < numChunks; i++) {
    const promptPath = join(rdPath, `step-0-split-${i + 1}-prompt.md`);
    const resultPath = join(rdPath, `step-0-split-${i + 1}-output.md`);
    await fs.writeFile(promptPath, `Chunk ${i + 1} prompt.`, 'utf8');
    chunks.push({
      index: i,
      items: [`item-${i + 1}`],
      prompt_path: promptPath,
      result_path: resultPath,
    });
  }

  return {
    phase: 'split',
    chunks,
    completed: new Array<boolean>(numChunks).fill(false),
    current_chunk_index: 0,
    rules: [],
  };
}

describe('split dispatch loop', () => {
  it('dispatches first chunk as tool-call on crash-recovery enter', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    step.state = await makeSplitState(run, 2);

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('split');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('split 1/2');
  });

  it('advances to chunk 2 after chunk 1 result with sentinel', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 2);
    step.state = splitState;

    await fs.writeFile(splitState.chunks[0]!.result_path, `Work done.\n${SENTINEL}\n`, 'utf8');

    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: splitState.chunks[0]!.result_path },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') expect(result.next.current_chunk_index).toBe(1);
    expect(result.instruction.body).toContain('split 2/2');
  });

  it('enters split_merge → complete after last chunk result (no artifact)', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 1);
    step.state = splitState;

    await fs.writeFile(splitState.chunks[0]!.result_path, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: splitState.chunks[0]!.result_path },
      },
      run,
      opts,
    );
    // split_merge immediately merges and transitions; no artifact → complete
    expect(result.next.phase).toBe('complete');
  });

  it('gates user when sentinel missing in split chunk', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 2);
    step.state = splitState;

    await fs.writeFile(splitState.chunks[0]!.result_path, 'No sentinel here.', 'utf8');

    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: splitState.chunks[0]!.result_path },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('AGENT_COMPLETE');
  });

  it('gates on error and stays on same chunk', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 2);
    step.state = splitState;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'timeout' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') expect(result.next.current_chunk_index).toBe(0);
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('retry');
  });

  it('decision=no skips chunk and advances index', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 2);
    step.state = splitState;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') expect(result.next.current_chunk_index).toBe(1);
  });

  it('decision=yes retries current chunk without advancing index', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const splitState = await makeSplitState(run, 2);
    step.state = splitState;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') expect(result.next.current_chunk_index).toBe(0);
    expect(result.instruction.body).toContain('split 1/2');
  });
});

// ── §6b: split_merge ──────────────────────────────────────────────────────

describe('split_merge', () => {
  it('merges chunk results into declared artifact and completes', async () => {
    const step = makeStep({ agent: 'hello', artifact: '.ewh-artifacts/merged.md' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const chunk1Result = join(rdPath, 'step-0-split-1-output.md');
    const chunk2Result = join(rdPath, 'step-0-split-2-output.md');
    await fs.writeFile(chunk1Result, `Finding A.\n${SENTINEL}\n`, 'utf8');
    await fs.writeFile(chunk2Result, `Finding B.\n${SENTINEL}\n`, 'utf8');

    const chunks: SplitChunk[] = [
      { index: 0, items: ['a'], prompt_path: join(rdPath, 'p1.md'), result_path: chunk1Result },
      { index: 1, items: ['b'], prompt_path: join(rdPath, 'p2.md'), result_path: chunk2Result },
    ];
    step.state = { phase: 'split_merge', chunks, rules: [] };

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');

    const artifact = join(tmpDir, '.ewh-artifacts', 'merged.md');
    const merged = await fs.readFile(artifact, 'utf8');
    expect(merged).toContain('Finding A.');
    expect(merged).toContain('Finding B.');
    expect(merged).not.toContain(SENTINEL);
  });

  it('completes without artifact write when none declared', async () => {
    const step = makeStep({ agent: 'hello' }); // no artifact
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    const chunkResult = join(rdPath, 'step-0-split-1-output.md');
    await fs.writeFile(chunkResult, `Done.\n${SENTINEL}\n`, 'utf8');

    const chunks: SplitChunk[] = [
      { index: 0, items: [], prompt_path: join(rdPath, 'p1.md'), result_path: chunkResult },
    ];
    step.state = { phase: 'split_merge', chunks, rules: [] };

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
  });

  it('tolerates missing chunk result file (uses stub text)', async () => {
    const step = makeStep({ agent: 'hello', artifact: '.ewh-artifacts/merged.md' });
    const run = makeRun([step]);
    const rdPath = await makeRunDir();

    // chunk 1 present, chunk 2 missing
    const chunk1Result = join(rdPath, 'step-0-split-1-output.md');
    await fs.writeFile(chunk1Result, `Only chunk.\n${SENTINEL}\n`, 'utf8');

    const chunks: SplitChunk[] = [
      { index: 0, items: ['a'], prompt_path: join(rdPath, 'p1.md'), result_path: chunk1Result },
      {
        index: 1,
        items: ['b'],
        prompt_path: join(rdPath, 'p2.md'),
        result_path: join(rdPath, 'missing.md'),
      },
    ];
    step.state = { phase: 'split_merge', chunks, rules: [] };

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');

    const artifact = join(tmpDir, '.ewh-artifacts', 'merged.md');
    const merged = await fs.readFile(artifact, 'utf8');
    expect(merged).toContain('Only chunk.');
    expect(merged).toContain('no output on disk');
  });
});

// ── §6e: artifact_verify ──────────────────────────────────────────────────

describe('artifact_verify', () => {
  function makeArtifactVerifyState(
    overrides?: Partial<Extract<StepState, { phase: 'artifact_verify' }>>,
  ): Extract<StepState, { phase: 'artifact_verify' }> {
    return {
      phase: 'artifact_verify',
      pending_summary: { step_name: 'greet', outcome: 'completed' },
      pending_rules: [],
      ...overrides,
    };
  }

  it('gates when artifact is missing on disk', async () => {
    const step = makeStep({ artifact: '.ewh-artifacts/missing.md' });
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('artifact_verify');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('retry');
    expect(result.instruction.body).toContain('skip');
    expect(result.instruction.body).toContain('abort');
  });

  it('decision=no skips the step', async () => {
    const step = makeStep({ artifact: '.ewh-artifacts/missing.md' });
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('skipped');
  });

  it('decision=yes re-checks and completes when artifact is now present', async () => {
    const artifactRel = '.ewh-artifacts/r01/present.md';
    const artifactAbs = join(tmpDir, artifactRel);
    await fs.mkdir(join(tmpDir, '.ewh-artifacts', 'r01'), { recursive: true });
    await fs.writeFile(artifactAbs, 'content', 'utf8');

    const step = makeStep({ artifact: artifactRel });
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });

  it('decision=yes re-gates when artifact still absent', async () => {
    const step = makeStep({ artifact: '.ewh-artifacts/still-missing.md' });
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('artifact_verify');
    expect(result.instruction.kind).toBe('user-prompt');
  });

  it('crash recovery (enter) re-checks artifact', async () => {
    const step = makeStep({ artifact: '.ewh-artifacts/missing.md' });
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('artifact_verify');
    expect(result.instruction.kind).toBe('user-prompt');
  });

  it('passes through without gate when no artifact declared', async () => {
    const step = makeStep({ agent: 'hello' }); // no artifact
    const run = makeRun([step]);
    step.state = makeArtifactVerifyState();

    // With no artifact declared, enterArtifactVerify skips straight to compliance → complete
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
  });

  it('agent_run → artifact present → complete (end-to-end)', async () => {
    const artifactRel = '.ewh-artifacts/r01/step-0-result.md';
    const step = makeStep({ agent: 'hello', artifact: artifactRel });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const artifactAbs = join(tmpDir, artifactRel);
    await fs.mkdir(join(tmpDir, '.ewh-artifacts', 'r01'), { recursive: true });
    await fs.writeFile(artifactAbs, 'artifact content', 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });
});
