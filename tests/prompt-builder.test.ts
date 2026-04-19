import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPrompt, extractFilesModified } from '../src/workflow/prompt-builder.js';
import type { RunState, Step } from '../src/state/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-prompt-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(overrides?: Partial<RunState>): RunState {
  return {
    run_id: 'test01',
    workflow: 'hello',
    raw_argv: 'hello',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    ...overrides,
  };
}

function makeStep(overrides?: Partial<Step>): Step {
  return {
    name: 'greet',
    gate: 'auto',
    description: 'Say hello.',
    state: { phase: 'pending' },
    ...overrides,
  };
}

describe('buildPrompt section order', () => {
  it('produces sections in documented order', async () => {
    const run = makeRun();
    const step = makeStep({
      reads: ['README.md'],
      artifact: '.ewh-artifacts/out.md',
    });

    const { promptPath } = await buildPrompt({
      step,
      agent: { name: 'hello', body: '## Role\n\nBe helpful.' },
      rules: [{ name: 'coding', body: '## Principles\n\nDo good work.', path: '' }],
      run,
      priorSteps: [],
      harnessConfig: 'Language: TypeScript',
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });

    const content = await fs.readFile(promptPath, 'utf8');

    const agentIdx = content.indexOf('## Role');
    const readingIdx = content.indexOf('## Required Reading');
    const rulesIdx = content.indexOf('## Active Rules');
    const taskIdx = content.indexOf('## Task');
    const contextIdx = content.indexOf('## Project Context');

    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(readingIdx).toBeGreaterThan(agentIdx);
    expect(rulesIdx).toBeGreaterThan(readingIdx);
    expect(taskIdx).toBeGreaterThan(rulesIdx);
    expect(contextIdx).toBeGreaterThan(taskIdx);
  });

  it('omits Required Reading when reads is empty', async () => {
    const { promptPath } = await buildPrompt({
      step: makeStep(),
      agent: { name: 'hello', body: 'Agent body.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).not.toContain('## Required Reading');
  });

  it('omits Active Rules when no rules', async () => {
    const { promptPath } = await buildPrompt({
      step: makeStep(),
      agent: { name: 'hello', body: 'Agent body.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).not.toContain('## Active Rules');
  });

  it('omits Prior Steps when priorSteps is empty', async () => {
    const { promptPath } = await buildPrompt({
      step: makeStep(),
      agent: { name: 'hello', body: 'Agent.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).not.toContain('## Prior Steps');
  });

  it('omits Project Context when harnessConfig is undefined', async () => {
    const { promptPath } = await buildPrompt({
      step: makeStep(),
      agent: { name: 'hello', body: 'Agent.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).not.toContain('## Project Context');
  });

  it('includes artifact write instruction in Task when artifact is set', async () => {
    const { promptPath } = await buildPrompt({
      step: makeStep({ artifact: '.ewh-artifacts/out.md' }),
      agent: { name: 'hello', body: 'Agent.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain('.ewh-artifacts/out.md');
  });

  it('result path is sibling to prompt path with -output suffix', async () => {
    const { promptPath, resultPath } = await buildPrompt({
      step: makeStep(),
      agent: { name: 'hello', body: 'Agent.' },
      rules: [],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 3,
      projectRoot: tmpDir,
    });
    expect(promptPath).toContain('step-3-prompt.md');
    expect(resultPath).toContain('step-3-output.md');
  });
});

describe('extractFilesModified', () => {
  it('extracts inline bracket list', () => {
    const content = 'files_modified: [src/a.ts, src/b.ts]';
    expect(extractFilesModified(content)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts YAML block list', () => {
    const content = 'files_modified:\n  - src/a.ts\n  - src/b.ts\nend';
    expect(extractFilesModified(content)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns undefined when key absent', () => {
    expect(extractFilesModified('no files here')).toBeUndefined();
  });

  it('handles markdown bullet prefix', () => {
    const content = '- files_modified: [src/a.ts]';
    expect(extractFilesModified(content)).toEqual(['src/a.ts']);
  });
});
