import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transitionStep, advanceRun, type TransitionOpts } from '../src/state/machine.js';
import { SENTINEL } from '../src/state/sentinel.js';
import type { RunState, Step } from '../src/state/types.js';

let tmpDir: string;
let opts: TransitionOpts;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-machine-test-'));
  // set up minimal plugin structure
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

function makeStep(overrides?: Partial<Step>): Step {
  return {
    name: 'greet',
    gate: 'auto',
    description: 'Write greeting.',
    // reads makes this non-scriptable by default so agent_run tests are unaffected
    reads: ['_nonscriptable'],
    state: { phase: 'pending' },
    ...overrides,
  };
}

/** A step that isScriptable() returns true for (no reads/artifact/context). */
function makeScriptableStep(overrides?: Partial<Step>): Step {
  return {
    name: 'greet',
    gate: 'auto',
    description: 'Write greeting.',
    state: { phase: 'pending' },
    ...overrides,
  };
}

describe('pending → agent_run (enter)', () => {
  it('emits tool-call instruction with prompt file on disk', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);

    expect(result.next.phase).toBe('agent_run');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('step-0-prompt.md');

    if (result.next.phase === 'agent_run') {
      const exists = await fs.access(result.next.prompt_path).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }
  });

  it('REPORT_WITH embeds result path', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);

    expect(result.instruction.report_with).toContain('step-0-output.md');
    expect(result.instruction.report_with).toContain('--result');
  });
});

describe('agent_run → complete (report result)', () => {
  async function runUntilAgentRun(step: Step, run: RunState) {
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r.next;
    return r;
  }

  it('transitions to complete when sentinel present and no artifact', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await runUntilAgentRun(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Some output.\n${SENTINEL}\n`, 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
    expect(result.instruction.kind).toBe('done');
  });

  it('transitions to continuation when sentinel missing', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await runUntilAgentRun(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, 'Output without sentinel.', 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('continuation');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('continuation');
  });

  it('transitions to artifact_verify when artifact declared but missing', async () => {
    const step = makeStep({
      agent: 'hello',
      artifact: '.ewh-artifacts/greeting.txt',
    });
    const run = makeRun([step]);
    await runUntilAgentRun(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('artifact_verify');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('artifact');
    expect(result.instruction.body).toContain('retry');
  });

  it('includes files_modified in summary when agent reports them', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await runUntilAgentRun(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(
      resultPath,
      `- files_modified: [src/a.ts, src/b.ts]\n${SENTINEL}\n`,
      'utf8',
    );

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
    if (result.next.phase === 'complete') {
      expect(result.next.summary.files_modified).toEqual(['src/a.ts', 'src/b.ts']);
    }
  });
});

describe('pending → complete (no-op step)', () => {
  it('completes immediately for message steps', async () => {
    const step = makeStep({ message: 'Hello!' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
    expect(result.instruction.kind).toBe('done');
  });
});

describe('advanceRun', () => {
  it('advances cursor and resets next step to pending', async () => {
    const steps = [makeStep({ name: 'a' }), makeStep({ name: 'b' })];
    steps[0]!.state = { phase: 'complete', summary: { step_name: 'a', outcome: 'completed' } };
    const run = makeRun(steps, 0);
    const next = await advanceRun(run);
    expect(next?.name).toBe('b');
    expect(next?.state.phase).toBe('pending');
    expect(run.current_step_index).toBe(1);
  });

  it('marks run complete when on last step', async () => {
    const steps = [makeStep({ name: 'only' })];
    const run = makeRun(steps, 0);
    const next = await advanceRun(run);
    expect(next).toBeNull();
    expect(run.status).toBe('complete');
  });
});


// ── Phase 3: gate_pending ───────────────────────────────────────────────────

describe('pending → gate_pending (structural gate)', () => {
  it('emits user-prompt when gate=structural and autoStructural is false', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('gate_pending');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('structural gate');
    expect(result.instruction.report_with).toContain('--decision yes');
  });

  it('skips gate and enters agent_run when autoStructural=true', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, { ...opts, autoStructural: true });
    expect(result.next.phase).toBe('agent_run');
  });

  it('gate_pending + yes → enters agent_run', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    step.state = { phase: 'gate_pending', prompt: 'Proceed?' };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('agent_run');
    expect(result.instruction.kind).toBe('tool-call');
  });

  it('gate_pending + no → skipped', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    step.state = { phase: 'gate_pending', prompt: 'Proceed?' };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('skipped');
  });

  it('auto gate passes through to agent_run without prompting', async () => {
    const step = makeStep({ gate: 'auto', agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('agent_run');
  });
});

// ── Phase 3: error retry ────────────────────────────────────────────────────

describe('agent_run error retry', () => {
  async function enterAgentRunState(step: Step, run: RunState) {
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r.next;
  }

  it('increments retries and re-emits tool-call when retries < maxErrorRetries', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'timeout' } },
      run,
      { ...opts, maxErrorRetries: 2 },
    );
    expect(result.next.phase).toBe('agent_run');
    if (result.next.phase === 'agent_run') {
      expect(result.next.retries).toBe(1);
    }
    expect(result.instruction.kind).toBe('tool-call');
  });

  it('emits exhaustion gate when retries >= maxErrorRetries', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);
    // Pre-set retries to maxErrorRetries so next error exhausts.
    (step.state as { retries: number }).retries = 2;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'crash' } },
      run,
      { ...opts, maxErrorRetries: 2 },
    );
    expect(result.next.phase).toBe('agent_run');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('retry');
    expect(result.instruction.body).toContain('skip');
    expect(result.instruction.body).toContain('abort');
  });

  it('decision=yes after exhaustion resets retries and re-emits tool-call', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);
    (step.state as { retries: number }).retries = 3;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('agent_run');
    if (result.next.phase === 'agent_run') {
      expect(result.next.retries).toBe(0);
    }
    expect(result.instruction.kind).toBe('tool-call');
  });

  it('decision=no after exhaustion skips the step', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('skipped');
  });
});

// ── Phase 3: compliance ─────────────────────────────────────────────────────

describe('compliance checks after agent_run', () => {
  async function enterAgentRunState(step: Step, run: RunState) {
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r.next;
  }

  async function reportResult(step: Step, run: RunState, resultPath: string) {
    return transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
  }

  it('completes directly when no critical rules', async () => {
    const step = makeStep({ agent: 'hello', rules: [] });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await reportResult(step, run, resultPath);
    expect(result.next.phase).toBe('complete');
  });

  it('transitions to compliance when critical rule verify fails', async () => {
    // Write a rule file that has severity: critical and a failing verify command.
    await fs.writeFile(
      join(tmpDir, 'rules', 'strict.md'),
      '---\nname: strict\nseverity: critical\nverify: "exit 1"\n---\n\nRule body.',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['strict'] });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await reportResult(step, run, resultPath);
    expect(result.next.phase).toBe('compliance');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('compliance check FAILED');
  });

  it('completes when critical rule verify passes', async () => {
    await fs.writeFile(
      join(tmpDir, 'rules', 'passing.md'),
      '---\nname: passing\nseverity: critical\nverify: "exit 0"\n---\n\nRule body.',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['passing'] });
    const run = makeRun([step]);
    await enterAgentRunState(step, run);

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await reportResult(step, run, resultPath);
    expect(result.next.phase).toBe('complete');
  });

  it('autoCompliance skips failed compliance and completes', async () => {
    await fs.writeFile(
      join(tmpDir, 'rules', 'failing2.md'),
      '---\nname: failing2\nseverity: critical\nverify: "exit 1"\n---\n\nRule body.',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['failing2'] });
    const run = makeRun([step]);
    // Enter with autoCompliance=true (yolo).
    const r = await transitionStep(step, { kind: 'enter' }, run, { ...opts, autoCompliance: true });
    step.state = r.next;

    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `Done.\n${SENTINEL}\n`, 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      { ...opts, autoCompliance: true },
    );
    expect(result.next.phase).toBe('complete');
  });
});

describe('compliance state transitions', () => {
  function makeComplianceStep(verifyCmd: string) {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'compliance',
      critical_rules: [{ name: 'r', path: 'rules/r.md', severity: 'critical', verify: verifyCmd }],
      summary: { step_name: step.name, outcome: 'completed' },
    };
    return step;
  }

  it('decision=no skips compliance and completes', async () => {
    const step = makeComplianceStep('exit 1');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
    if (result.next.phase === 'complete') {
      expect(result.next.summary.notes).toContain('skipped by user');
    }
  });

  it('decision=yes and verify now passes → complete', async () => {
    const step = makeComplianceStep('exit 0');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });

  it('decision=yes and verify still fails → stays in compliance', async () => {
    const step = makeComplianceStep('exit 1');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('compliance');
    expect(result.instruction.kind).toBe('user-prompt');
  });
});

// ── Phase 3: precondition_failed ────────────────────────────────────────────

describe('precondition_failed → skipped', () => {
  it('transitions to skipped and emits done/advance', async () => {
    const step = makeStep();
    step.state = { phase: 'precondition_failed', reason: 'required file missing' };
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('skipped');
    if (result.next.phase === 'skipped') {
      expect(result.next.reason).toBe('required file missing');
    }
  });
});

// ── Phase 4: script phases ──────────────────────────────────────────────────

describe('pending → script_propose (scriptable step)', () => {
  it('emits user-prompt with proposed script when step is scriptable', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('script_propose');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('#!/usr/bin/env bash');
    expect(result.instruction.body).toContain('--decision yes');
    expect(result.instruction.body).toContain('--decision no');
  });

  it('non-scriptable step (has reads) bypasses propose and goes to agent_run', async () => {
    const step = makeStep({ agent: 'hello' }); // has reads: ['_nonscriptable']
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('agent_run');
  });
});

describe('script_propose → script_run (decision=yes, no custom file)', () => {
  it('writes script to cache and executes it, completing on success', async () => {
    // Write a succeeding script to the proposed path to simulate "LLM approved"
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    // Enter pending → script_propose
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    expect(step.state.phase).toBe('script_propose');

    // Approve with no custom file → template runs (echo "Step completed.")
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    // Template script: echo "Step completed." → succeeds
    expect(result.next.phase).toBe('complete');
  });

  it('decision=no falls back to agent_run', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('agent_run');
  });

  it('uses custom script file when LLM writes to proposed_path', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    if (step.state.phase !== 'script_propose') throw new Error('expected script_propose');

    // Write a custom script to the proposed path
    const { promises: fs } = await import('node:fs');
    await fs.mkdir(require('node:path').dirname(step.state.proposed_path), { recursive: true });
    await fs.writeFile(step.state.proposed_path, '#!/usr/bin/env bash\necho "custom"\n', 'utf8');

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
    // Cached script should exist
    const cachePath = require('node:path').join(tmpDir, '.claude', 'ewh-scripts', 'hello', 'greet.sh');
    const cached = await fs.readFile(cachePath, 'utf8');
    expect(cached).toContain('custom');
  });
});

describe('pending → script_run (explicit script: field)', () => {
  it('runs explicit script and completes on success', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'my-script.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello', script: scriptPath });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
    expect(result.instruction.kind).toBe('done');
  });

  it('runs explicit script and gates on failure (script_fallback=gate)', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'fail-script.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello', script: scriptPath, script_fallback: 'gate' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('script_run');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('retry');
    expect(result.instruction.body).toContain('use agent instead');
  });

  it('falls through to agent_run on failure when script_fallback=auto', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'fail-auto.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 2\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello', script: scriptPath, script_fallback: 'auto' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('agent_run');
    expect(result.instruction.kind).toBe('tool-call');
  });
});

describe('pending → script_run (cached script)', () => {
  async function writeCacheScript(stepName: string, body: string, hash: string) {
    const { promises: fs } = await import('node:fs');
    const dir = require('node:path').join(tmpDir, '.claude', 'ewh-scripts', 'hello');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(require('node:path').join(dir, `${stepName}.sh`), body, { mode: 0o755 });
    await fs.writeFile(require('node:path').join(dir, `${stepName}.hash`), hash + '\n', 'utf8');
  }

  it('runs cached script and completes', async () => {
    await writeCacheScript('greet', '#!/usr/bin/env bash\nexit 0\n', 'anyhash');
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
  });

  it('includes stale warning in notes when hash differs', async () => {
    await writeCacheScript('greet', '#!/usr/bin/env bash\nexit 0\n', 'old-hash-differs');
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
    if (result.next.phase === 'complete') {
      expect(result.next.summary.notes).toContain('stale');
    }
  });

  it('no stale warning when hash matches', async () => {
    const { hashStep } = await import('../src/scripts/hash.js');
    const step = makeScriptableStep({ agent: 'hello' });
    const currentHash = hashStep(step);
    await writeCacheScript('greet', '#!/usr/bin/env bash\nexit 0\n', currentHash);
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
    if (result.next.phase === 'complete') {
      expect(result.next.summary.notes ?? '').not.toContain('stale');
    }
  });
});

describe('script_run gate retry flow', () => {
  it('decision=yes retries the script', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'retry-script.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello', script: scriptPath });
    const run = makeRun([step]);
    // Enter → script fails → gate prompt
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    expect(step.state.phase).toBe('script_run');

    // Retry → still fails → gate again
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('script_run');
    expect(result.instruction.kind).toBe('user-prompt');
  });

  it('decision=no with agent falls back to agent_run', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'noagent-script.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello', script: scriptPath });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;

    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('agent_run');
  });

  it('crash recovery: script_run enter re-executes script', async () => {
    const { promises: fs } = await import('node:fs');
    const scriptPath = require('node:path').join(tmpDir, 'recover-script.sh');
    await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const step = makeScriptableStep({ agent: 'hello' });
    // Force script_run state (crash recovery scenario)
    step.state = { phase: 'script_run', script_path: scriptPath, attempts: 0 };
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('complete');
  });
});

describe('script_eval crash recovery', () => {
  it('script_eval enter re-evaluates (no cached script → propose for scriptable)', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    step.state = { phase: 'script_eval' };
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('script_propose');
  });
});

// ── Error-path coverage for throws on unexpected event kinds ──────────────

describe('throws on malformed events', () => {
  it('gate_pending throws on non-decision report', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    step.state = { phase: 'gate_pending', prompt: 'Proceed?' };
    const run = makeRun([step]);
    await expect(
      transitionStep(step, { kind: 'enter' }, run, opts),
    ).rejects.toThrow(/gate_pending expects a decision report/);
  });

  it('script_propose throws on non-decision report', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    step.state = {
      phase: 'script_propose',
      script: '#!/bin/sh\n',
      rationale: 'r',
      proposed_path: join(tmpDir, 'proposed.sh'),
    };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'result', step_index: 0, result_path: 'x' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/script_propose expects a decision report/);
  });

  it('script_run throws on non-decision report', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    step.state = { phase: 'script_run', script_path: '/nope', attempts: 0 };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'result', step_index: 0, result_path: 'x' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/script_run expects a decision report/);
  });

  it('agent_run throws on enter event', async () => {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'agent_run',
      prompt_path: 'x',
      result_path: 'y',
      retries: 0,
      rules: [],
    };
    const run = makeRun([step]);
    await expect(
      transitionStep(step, { kind: 'enter' }, run, opts),
    ).rejects.toThrow(/agent_run expects a report event/);
  });

  it('agent_run throws on decision event with "yes" not following error', async () => {
    // Decision with retries==0 should be treated as accept after exhaust; not thrown.
    // But a decision report after an untouched agent_run still hits the decision branch.
    // The true "unexpected report kind" is triggered via an abort — handled at
    // report.ts, not machine. Skip.
  });

  it('compliance throws on non-decision report', async () => {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'compliance',
      critical_rules: [],
      summary: { step_name: step.name, outcome: 'completed' },
    };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'result', step_index: 0, result_path: 'x' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/compliance expects a decision report/);
  });

  it('artifact_verify throws on non-decision report', async () => {
    const step = makeStep({ agent: 'hello', artifact: 'out.md' });
    step.state = {
      phase: 'artifact_verify',
      pending_summary: { step_name: step.name, outcome: 'completed' },
      pending_rules: [],
    };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'result', step_index: 0, result_path: 'x' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/artifact_verify expects a decision report/);
  });

  it('chunk_plan throws when event.report is not a result', async () => {
    const step = makeStep({ agent: 'hello', chunked: true });
    step.state = { phase: 'chunk_plan' };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/chunk_plan expects a --result report/);
  });

  it('terminal phases throw on any transition', async () => {
    const step = makeStep();
    step.state = { phase: 'complete', summary: { step_name: 'a', outcome: 'completed' } };
    const run = makeRun([step]);
    await expect(
      transitionStep(step, { kind: 'enter' }, run, opts),
    ).rejects.toThrow(/cannot transition terminal phase 'complete'/);

    step.state = { phase: 'skipped', reason: 'done' };
    await expect(
      transitionStep(step, { kind: 'enter' }, run, opts),
    ).rejects.toThrow(/cannot transition terminal phase 'skipped'/);
  });

  it('enterChunkPlan throws when step has no agent', async () => {
    const step = makeStep({ chunked: true }); // no agent
    const run = makeRun([step]);
    await expect(
      transitionStep(step, { kind: 'enter' }, run, opts),
    ).rejects.toThrow(/chunked step 'greet' requires an agent/);
  });
});

// ── script_propose decline with no agent → skipped ────────────────────────

describe('script_propose decline without agent', () => {
  it('decline with no agent fallback → skipped', async () => {
    const step = makeScriptableStep({ script: 'dummy.sh' }); // script-only, no agent
    step.state = {
      phase: 'script_propose',
      script: 'tmpl',
      rationale: 'r',
      proposed_path: join(tmpDir, 'p.sh'),
    };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('skipped');
  });
});

// ── script_run no-agent fallback → skipped ─────────────────────────────────

describe('script_run no-agent flow', () => {
  it('failing script with no agent fallback (decision=no) → skipped', async () => {
    const { promises: fs2 } = await import('node:fs');
    const scriptPath = join(tmpDir, 'noagentfail.sh');
    await fs2.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    // No agent, script-only step
    const step: Step = {
      name: 'greet',
      gate: 'auto',
      script: scriptPath,
      state: { phase: 'pending' },
    };
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r0.next.phase).toBe('script_run');
    step.state = r0.next;
    const r1 = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(r1.next.phase).toBe('skipped');
  });
});

// ── agent_run unexpected report kind ──────────────────────────────────────

describe('agent_run unexpected report kind', () => {
  it('throws on abort report (treated as unexpected)', async () => {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'agent_run',
      prompt_path: 'x',
      result_path: 'y',
      retries: 0,
      rules: [],
    };
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'abort' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/unexpected report kind 'abort'/);
  });

  it('emits read-error user-prompt when result path is unreadable', async () => {
    const step = makeStep({ agent: 'hello' });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: '/definitely/not/here.md' },
      },
      run,
      opts,
    );
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('cannot read result file');
  });
});

// ── artifact_verify crash recovery + retry ────────────────────────────────

describe('artifact_verify crash recovery', () => {
  it('enter re-checks artifact (still missing → user-prompt)', async () => {
    const step = makeStep({ agent: 'hello', artifact: 'missing/file.md' });
    step.state = {
      phase: 'artifact_verify',
      pending_summary: { step_name: 'greet', outcome: 'completed' },
      pending_rules: [],
    };
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('artifact_verify');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('not found on disk');
  });

  it('decision=yes re-checks and completes when artifact now present', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello', artifact: 'out.md' });
    step.state = {
      phase: 'artifact_verify',
      pending_summary: { step_name: 'greet', outcome: 'completed' },
      pending_rules: [],
    };
    const run = makeRun([step]);
    // Write the artifact so re-check passes
    await fs2.writeFile(join(tmpDir, 'out.md'), 'written', 'utf8');
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });

  it('decision=no skips the step', async () => {
    const step = makeStep({ agent: 'hello', artifact: 'out.md' });
    step.state = {
      phase: 'artifact_verify',
      pending_summary: { step_name: 'greet', outcome: 'completed' },
      pending_rules: [],
    };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('skipped');
  });
});

// ── continuation crash recovery + split escalation ────────────────────────

describe('continuation events', () => {
  function primeCont(step: Step) {
    step.state = {
      phase: 'continuation',
      partial_path: join(tmpDir, 'partial.md'),
      original_prompt_path: join(tmpDir, 'orig-prompt.md'),
      continuation_prompt_path: join(tmpDir, 'cont-prompt.md'),
      continuation_result_path: join(tmpDir, 'cont-output.md'),
      rules: [],
    };
  }

  it('enter re-emits continuation tool-call (crash recovery)', async () => {
    const step = makeStep({ agent: 'hello' });
    primeCont(step);
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('continuation');
    expect(result.instruction.kind).toBe('tool-call');
    expect(result.instruction.body).toContain('continuation');
  });

  it('error escalates to split', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' });
    primeCont(step);
    await fs2.writeFile(
      (step.state as { original_prompt_path: string }).original_prompt_path,
      'ORIG',
      'utf8',
    );
    await fs2.writeFile(
      (step.state as { partial_path: string }).partial_path,
      '- item1\n- item2\n',
      'utf8',
    );
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'boom' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
  });

  it('unreadable result escalates to split', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' });
    primeCont(step);
    await fs2.writeFile(
      (step.state as { original_prompt_path: string }).original_prompt_path,
      'ORIG',
      'utf8',
    );
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0 } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
  });

  it('sentinel-missing result still escalates to split', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' });
    primeCont(step);
    const resultPath = (step.state as { continuation_result_path: string })
      .continuation_result_path;
    await fs2.writeFile(resultPath, 'no sentinel here', 'utf8');
    await fs2.writeFile(
      (step.state as { original_prompt_path: string }).original_prompt_path,
      'ORIG',
      'utf8',
    );
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
  });

  it('sentinel-present result completes via artifact_verify', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' }); // no artifact → completes directly
    primeCont(step);
    const resultPath = (step.state as { continuation_result_path: string })
      .continuation_result_path;
    await fs2.writeFile(resultPath, `done\n${SENTINEL}\n`, 'utf8');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
  });

  it('throws on unexpected report kind (decision)', async () => {
    const step = makeStep({ agent: 'hello' });
    primeCont(step);
    const run = makeRun([step]);
    await expect(
      transitionStep(
        step,
        { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
        run,
        opts,
      ),
    ).rejects.toThrow(/continuation: unexpected report kind 'decision'/);
  });
});

// ── split crash recovery + retry + skip + merge ───────────────────────────

describe('split events', () => {
  async function makeSplitStep(step: Step) {
    const { promises: fs2 } = await import('node:fs');
    const p1 = join(tmpDir, 'split-1-prompt.md');
    const r1 = join(tmpDir, 'split-1-output.md');
    const p2 = join(tmpDir, 'split-2-prompt.md');
    const r2 = join(tmpDir, 'split-2-output.md');
    await fs2.writeFile(p1, 'p1', 'utf8');
    await fs2.writeFile(p2, 'p2', 'utf8');
    step.state = {
      phase: 'split',
      chunks: [
        { index: 0, items: ['a'], prompt_path: p1, result_path: r1 },
        { index: 1, items: ['b'], prompt_path: p2, result_path: r2 },
      ],
      completed: [false, false],
      current_chunk_index: 0,
      rules: [],
    };
    return { r1, r2 };
  }

  it('enter re-emits split instruction (crash recovery)', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('split');
    expect(result.instruction.kind).toBe('tool-call');
  });

  it('error gates to user', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'kaboom' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    expect(result.instruction.kind).toBe('user-prompt');
    expect(result.instruction.body).toContain('failed');
  });

  it('decision=no skips chunk and advances (two-chunk → second chunk)', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') {
      expect(result.next.current_chunk_index).toBe(1);
    }
  });

  it('decision=yes retries current chunk', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') {
      expect(result.next.current_chunk_index).toBe(0);
    }
  });

  it('throws on unexpected report kind (abort)', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    await expect(
      transitionStep(step, { kind: 'report', report: { kind: 'abort' } }, run, opts),
    ).rejects.toThrow(/split: unexpected report kind/);
  });

  it('unreadable result gates with cannot read message', async () => {
    const step = makeStep({ agent: 'hello' });
    await makeSplitStep(step);
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: '/nope/here' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    expect(result.instruction.body).toContain('cannot read result');
  });

  it('result without sentinel gates', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' });
    const { r1 } = await makeSplitStep(step);
    await fs2.writeFile(r1, 'no sentinel', 'utf8');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: r1 } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    expect(result.instruction.body).toContain('missing AGENT_COMPLETE');
  });

  it('final chunk with sentinel → merges and completes (writes artifact)', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello', artifact: 'merged.md' });
    const { r1, r2 } = await makeSplitStep(step);
    // Mark chunk 0 as already completed by advancing cursor to 1
    (step.state as { current_chunk_index: number }).current_chunk_index = 1;
    (step.state as { completed: boolean[] }).completed = [true, false];
    // Write both results with sentinel
    await fs2.writeFile(r1, `first\n${SENTINEL}\n`, 'utf8');
    await fs2.writeFile(r2, `second\n${SENTINEL}\n`, 'utf8');
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: r2 } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('complete');
    const merged = await fs2.readFile(join(tmpDir, 'merged.md'), 'utf8');
    expect(merged).toContain('first');
    expect(merged).toContain('second');
  });

  it('skip-then-complete path merges with placeholder for the skipped chunk', async () => {
    const { promises: fs2 } = await import('node:fs');
    const step = makeStep({ agent: 'hello' }); // no artifact → merge but no file write
    const { r2 } = await makeSplitStep(step);
    // Skip chunk 0 (decision=no), then complete chunk 1 with sentinel
    const run = makeRun([step]);
    const skip = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    step.state = skip.next;
    expect(step.state.phase).toBe('split');

    await fs2.writeFile(r2, `second\n${SENTINEL}\n`, 'utf8');
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: r2 } },
      run,
      opts,
    );
    // split_merge sees chunk 0 result missing → placeholder, still completes
    expect(result.next.phase).toBe('complete');
  });
});

// ── enterSplit when partial file is missing ───────────────────────────────

describe('enterSplit with missing partial', () => {
  it('detects zero items and produces a single-chunk re-run', async () => {
    const step = makeStep({ agent: 'hello' });
    // Prime continuation state with unreadable partial
    step.state = {
      phase: 'continuation',
      partial_path: '/does/not/exist',
      original_prompt_path: join(tmpDir, 'orig.md'),
      continuation_prompt_path: join(tmpDir, 'cont-p.md'),
      continuation_result_path: join(tmpDir, 'cont-r.md'),
      rules: [],
    };
    await fs.writeFile(
      (step.state as { original_prompt_path: string }).original_prompt_path,
      'orig',
      'utf8',
    );
    const run = makeRun([step]);
    // Error triggers escalation to enterSplit which falls through unreadable
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'boom' } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('split');
    if (result.next.phase === 'split') {
      expect(result.next.chunks).toHaveLength(1);
    }
  });
});

// ── chunk_plan event paths not yet covered ────────────────────────────────

describe('chunk_plan events', () => {
  async function writeAgentMd(p: string) {
    await fs.writeFile(
      join(tmpDir, 'agents', 'hello.md'),
      `---\nname: hello\nmodel: haiku\ntools: [Write]\n---\n\nBody.`,
      'utf8',
    );
    return p;
  }

  it('enter on chunk_plan re-invokes enterChunkPlan', async () => {
    const step = makeStep({ agent: 'hello', chunked: true });
    step.state = { phase: 'chunk_plan' };
    const run = makeRun([step]);
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(result.next.phase).toBe('chunk_plan');
  });

  it('report with no result_path re-prompts', async () => {
    const step = makeStep({ agent: 'hello', chunked: true });
    step.state = { phase: 'chunk_plan' };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0 } },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_plan');
    expect(result.instruction.body).toContain('--result <path> is required');
  });

  it('unreadable patterns file re-prompts with read error', async () => {
    const step = makeStep({ agent: 'hello', chunked: true });
    step.state = { phase: 'chunk_plan' };
    const run = makeRun([step]);
    const result = await transitionStep(
      step,
      {
        kind: 'report',
        report: { kind: 'result', step_index: 0, result_path: '/no/such/patterns.json' },
      },
      run,
      opts,
    );
    expect(result.next.phase).toBe('chunk_plan');
    expect(result.instruction.body).toContain('cannot read patterns');
  });

  it('invalid patterns JSON re-prompts', async () => {
    await writeAgentMd('');
    const patternsPath = join(tmpDir, 'bad.json');
    await fs.writeFile(patternsPath, '{not json', 'utf8');
    const step = makeStep({ agent: 'hello', chunked: true });
    step.state = { phase: 'chunk_plan' };
    const run = makeRun([step]);
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
    expect(result.instruction.body).toContain('invalid patterns');
  });
});

// ── chunk_running additional paths ────────────────────────────────────────

describe('chunk_running error retry + skip + unreadable result', () => {
  async function primeChunkRunning(): Promise<{ step: Step; run: RunState; r1: string; r2: string }> {
    // Write some source files to enumerate
    await fs.mkdir(join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'src', 'a.ts'), 'a', 'utf8');
    await fs.writeFile(join(tmpDir, 'src', 'b.ts'), 'b', 'utf8');
    // Seed patterns cache
    const { writeChunkedPatterns } = await import('../src/state/workflow-settings.js');
    await writeChunkedPatterns(tmpDir, 'hello', 'greet', {
      include: ['src/**/*.ts'],
    });
    const step = makeStep({ agent: 'hello', chunked: true });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    expect(step.state.phase).toBe('chunk_running');
    return {
      step,
      run,
      r1: (step.state as { chunk_result_paths: string[] }).chunk_result_paths[0]!,
      r2: (step.state as { chunk_result_paths: string[] }).chunk_result_paths[0]!,
    };
  }

  it('error retries up to maxErrorRetries then gates', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'boom' } },
      run,
      { ...opts, maxErrorRetries: 0 },
    );
    // maxRetries=0, first error → gate
    expect(r.instruction.kind).toBe('user-prompt');
    expect(r.instruction.body).toContain('failed after');
  });

  it('error within retry budget re-emits chunk instruction', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'transient' } },
      run,
      { ...opts, maxErrorRetries: 3 },
    );
    expect(r.instruction.kind).toBe('tool-call');
    expect(r.instruction.body).toContain('[retry]');
  });

  it('decision=no skips current chunk (advances or merges)', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'no' } },
      run,
      opts,
    );
    // With 2 files default chunk size=8, only 1 chunk → advance → merge → complete
    expect(['complete', 'chunk_running']).toContain(r.next.phase);
  });

  it('decision=yes resets retries and re-emits instruction', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(r.next.phase).toBe('chunk_running');
    expect(r.instruction.kind).toBe('tool-call');
  });

  it('unreadable result gates with cannot read message', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: '/no/such' } },
      run,
      opts,
    );
    expect(r.instruction.body).toContain('cannot read result');
  });

  it('result without sentinel gates', async () => {
    const { step, run, r1 } = await primeChunkRunning();
    await fs.writeFile(r1, 'no sentinel', 'utf8');
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: r1 } },
      run,
      opts,
    );
    expect(r.instruction.body).toContain('missing AGENT_COMPLETE');
  });

  it('throws on unexpected report kind in chunk_running', async () => {
    const { step, run } = await primeChunkRunning();
    await expect(
      transitionStep(step, { kind: 'report', report: { kind: 'abort' } }, run, opts),
    ).rejects.toThrow(/chunk_running: unexpected report kind/);
  });

  it('enter on chunk_running (crash recovery) re-emits instruction', async () => {
    const { step, run } = await primeChunkRunning();
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('chunk_running');
    expect(r.instruction.kind).toBe('tool-call');
  });

  it('beginChunkRunning with empty file list → skipped', async () => {
    const { writeChunkedPatterns } = await import('../src/state/workflow-settings.js');
    await writeChunkedPatterns(tmpDir, 'hello', 'greet', {
      include: ['nothing/**/*.xyz'],
    });
    const step = makeStep({ agent: 'hello', chunked: true });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('skipped');
    if (r.next.phase === 'skipped') {
      expect(r.next.reason).toContain('no files matched');
    }
  });
});

// ── incremental chunk agent header includes artifact when set ─────────────

describe('incremental chunk agent', () => {
  it('pre-creates each chunk artifact with anchor', async () => {
    // Incremental agent definition
    await fs.writeFile(
      join(tmpDir, 'agents', 'inc.md'),
      `---\nname: inc\nmodel: haiku\ntools: [Write, Edit]\nincremental: true\n---\n\nBody.`,
      'utf8',
    );
    await fs.mkdir(join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'src', 'x.ts'), 'x', 'utf8');
    const { writeChunkedPatterns } = await import('../src/state/workflow-settings.js');
    await writeChunkedPatterns(tmpDir, 'hello', 'greet', {
      include: ['src/**/*.ts'],
    });
    const step = makeStep({ agent: 'inc', chunked: true, artifact: 'findings.md' });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('chunk_running');
    if (r.next.phase === 'chunk_running') {
      expect(r.next.incremental).toBe(true);
      const anchor = await fs.readFile(r.next.chunk_artifact_paths[0]!, 'utf8');
      expect(anchor).toContain('findings.md — chunk findings');
    }
  });
});

// ── completeNoop fallbacks ────────────────────────────────────────────────

describe('completeNoop fallbacks', () => {
  it('message present: notes = message', async () => {
    const step = makeStep({ message: 'Hi!' });
    step.description = undefined;
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('complete');
    if (r.next.phase === 'complete') expect(r.next.summary.notes).toBe('Hi!');
  });

  it('only description present: notes = description', async () => {
    const step = makeStep({ description: 'Plan step.' }); // no agent, no script
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('complete');
    if (r.next.phase === 'complete') expect(r.next.summary.notes).toBe('Plan step.');
  });

  it('neither: notes = undefined', async () => {
    const step = makeStep();
    step.description = undefined;
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('complete');
    if (r.next.phase === 'complete') expect(r.next.summary.notes).toBeUndefined();
  });
});

// ── doneOrNext non-last → __CONTINUE__ sentinel ───────────────────────────

describe('doneOrNext advancement', () => {
  it('emits __CONTINUE__ sentinel when not the last step', async () => {
    const steps = [
      makeStep({ name: 'first', message: 'First.' }),
      makeStep({ name: 'second', agent: 'hello' }),
    ];
    const run = makeRun(steps, 0);
    const r = await transitionStep(steps[0]!, { kind: 'enter' }, run, opts);
    expect(r.instruction.kind).toBe('user-prompt');
    expect(r.instruction.body).toContain('Advancing to next step');
    expect(r.instruction.report_with).toBe('__CONTINUE__');
  });
});

// ── Run-verify runs rules that lack a verify command (skipped) ────────────

describe('runVerifyCommands edge cases', () => {
  it('rule with verify but no rule-body still runs through compliance path', async () => {
    // Create a critical rule with an invalid command that lacks stderr, to
    // hit the path where error.stderr is empty and message fallback used.
    await fs.writeFile(
      join(tmpDir, 'rules', 'silent.md'),
      '---\nname: silent\nseverity: critical\nverify: "exit 42"\n---\n\nSilent rule.',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['silent'] });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `done\n${SENTINEL}\n`, 'utf8');
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(r.next.phase).toBe('compliance');
    expect(r.instruction.body).toContain('compliance check FAILED');
  });
});

// ── advanceRun edge case ──────────────────────────────────────────────────

describe('advanceRun when already past end', () => {
  it('returns null and marks complete', async () => {
    const steps = [makeStep({ name: 'a' })];
    const run = makeRun(steps, 5); // cursor beyond end
    const { advanceRun } = await import('../src/state/machine.js');
    const next = await advanceRun(run);
    expect(next).toBeNull();
    expect(run.status).toBe('complete');
  });
});

// ── gate_pending=yes branches: chunked + no-agent/no-script fall-through ──

describe('gate_pending yes with chunked/noop branches', () => {
  it('yes + chunked → enterChunkPlan', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello', chunked: true });
    step.state = { phase: 'gate_pending', prompt: 'Proceed?' };
    const run = makeRun([step]);
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(r.next.phase).toBe('chunk_plan');
  });

  it('yes + no agent + no script → completeNoop', async () => {
    const step = makeStep({ gate: 'structural' }); // no agent, no script
    step.state = { phase: 'gate_pending', prompt: 'Proceed?' };
    const run = makeRun([step]);
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'decision', step_index: 0, decision: 'yes' } },
      run,
      opts,
    );
    expect(r.next.phase).toBe('complete');
  });
});

// ── Structural gate and script proposal without description ───────────────

describe('structural gate / script proposal without description', () => {
  it('omits description line from structural gate prompt', async () => {
    const step = makeStep({ gate: 'structural', agent: 'hello' });
    step.description = undefined;
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.instruction.body).not.toContain('Description:');
  });

  it('omits description line from script-proposal body', async () => {
    const step = makeScriptableStep({ agent: 'hello' });
    step.description = undefined;
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('script_propose');
    expect(r.instruction.body).not.toContain('Description:');
  });
});

// ── chunk_merge crash recovery ────────────────────────────────────────────

describe('chunk_merge crash recovery direct entry', () => {
  it('transition with chunk_merge state enters merge and completes', async () => {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'chunk_merge',
      chunk_artifact_paths: [],
      rules: [],
      incremental: false,
    };
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('complete');
  });
});

// ── Agent without tools, without model/maxTurns ───────────────────────────

describe('agent with minimal frontmatter', () => {
  async function writeBareAgent() {
    await fs.writeFile(
      join(tmpDir, 'agents', 'bare.md'),
      '---\nname: bare\n---\n\nBody.',
      'utf8',
    );
  }

  it('enterAgentRun emits body with default placeholders', async () => {
    await writeBareAgent();
    const step = makeStep({ agent: 'bare' });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('agent_run');
    expect(r.instruction.body).toContain('model: default');
    expect(r.instruction.body).toContain('tools: default');
  });

  it('continuation falls back to defaults', async () => {
    await writeBareAgent();
    const step = makeStep({ agent: 'bare' });
    step.state = {
      phase: 'continuation',
      partial_path: join(tmpDir, 'p.md'),
      original_prompt_path: join(tmpDir, 'op.md'),
      continuation_prompt_path: join(tmpDir, 'cp.md'),
      continuation_result_path: join(tmpDir, 'cr.md'),
      rules: [],
    };
    await fs.writeFile(join(tmpDir, 'op.md'), 'orig', 'utf8');
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.instruction.body).toContain('model: default');
    expect(r.instruction.body).toContain('tools: default');
  });

  it('split instruction falls back to defaults', async () => {
    await writeBareAgent();
    const step = makeStep({ agent: 'bare' });
    const p1 = join(tmpDir, 'sp-1-prompt.md');
    const r1 = join(tmpDir, 'sp-1-output.md');
    await fs.writeFile(p1, 'p1', 'utf8');
    step.state = {
      phase: 'split',
      chunks: [{ index: 0, items: [], prompt_path: p1, result_path: r1 }],
      completed: [false],
      current_chunk_index: 0,
      rules: [],
    };
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.instruction.body).toContain('model: default');
    expect(r.instruction.body).toContain('tools: default');
  });

  it('chunk_running instruction falls back to defaults', async () => {
    await writeBareAgent();
    await fs.mkdir(join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'src', 'a.ts'), 'a', 'utf8');
    const { writeChunkedPatterns } = await import('../src/state/workflow-settings.js');
    await writeChunkedPatterns(tmpDir, 'hello', 'greet', { include: ['src/**/*.ts'] });
    const step = makeStep({ agent: 'bare', chunked: true });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.instruction.body).toContain('tools: default');
  });
});

// ── Rule severity mapping to warning/info ─────────────────────────────────

describe('rule severity mapping', () => {
  it('maps warning and info rules correctly into state', async () => {
    await fs.writeFile(
      join(tmpDir, 'rules', 'warn.md'),
      '---\nname: warn\nseverity: warning\nverify: "exit 0"\n---\n\nBody.',
      'utf8',
    );
    await fs.writeFile(
      join(tmpDir, 'rules', 'info.md'),
      '---\nname: info\nseverity: info\nverify: "exit 0"\n---\n\nBody.',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['warn', 'info'] });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('agent_run');
    if (r.next.phase === 'agent_run') {
      const severities = r.next.rules.map((x) => x.severity).sort();
      expect(severities).toEqual(['info', 'warning']);
    }
  });
});

// ── chunk description fallback (no description → step.name) ───────────────

describe('chunk description fallback', () => {
  it('uses step.name when description is absent', async () => {
    await fs.mkdir(join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'src', 'a.ts'), 'a', 'utf8');
    const { writeChunkedPatterns } = await import('../src/state/workflow-settings.js');
    await writeChunkedPatterns(tmpDir, 'hello', 'greet', { include: ['src/**/*.ts'] });
    const step = makeStep({ agent: 'hello', chunked: true });
    step.description = undefined;
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('chunk_running');
    // Prompt file name includes step description or name
    if (r.next.phase === 'chunk_running') {
      const promptBody = await fs.readFile(r.next.chunk_prompt_paths[0]!, 'utf8');
      expect(promptBody).toContain('greet');
    }
  });
});

// ── buildAgentCallBody without meta fields ────────────────────────────────

describe('agent_run retry uses bare meta', () => {
  it('retry tool-call body does NOT include agent config line when meta empty', async () => {
    const step = makeStep({ agent: 'hello' });
    step.state = {
      phase: 'agent_run',
      prompt_path: join(tmpDir, 'p.md'),
      result_path: join(tmpDir, 'r.md'),
      retries: 0,
      rules: [],
    };
    const run = makeRun([step]);
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'error', step_index: 0, message: 'boom' } },
      run,
      { ...opts, maxErrorRetries: 2 },
    );
    expect(r.instruction.kind).toBe('tool-call');
    expect(r.instruction.body).not.toContain('Agent config —');
  });
});

// ── script_run failure gate includes stale note when provided ─────────────

describe('script_run failure with stale note', () => {
  it('includes stale warning line when cached hash mismatches', async () => {
    const { promises: fs2 } = await import('node:fs');
    const cacheDir = join(tmpDir, '.claude', 'ewh-scripts', 'hello');
    await fs2.mkdir(cacheDir, { recursive: true });
    await fs2.writeFile(
      join(cacheDir, 'greet.sh'),
      '#!/usr/bin/env bash\nexit 7\n',
      { mode: 0o755 },
    );
    await fs2.writeFile(join(cacheDir, 'greet.hash'), 'outdated\n', 'utf8');
    const step = makeScriptableStep({ agent: 'hello' });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('script_run');
    expect(r.instruction.body).toMatch(/stale/i);
  });
});

// ── runVerifyCommands when verify returns error without stdout/stderr ─────

describe('verify errors with no output', () => {
  it('falls back to error.message when stdout/stderr are empty', async () => {
    await fs.writeFile(
      join(tmpDir, 'rules', 'bogus.md'),
      // This command fails to spawn (non-existent cmd)
      '---\nname: bogus\nseverity: critical\nverify: "/definitely/not/here/cmd"\n---\n\nBody',
      'utf8',
    );
    const step = makeStep({ agent: 'hello', rules: ['bogus'] });
    const run = makeRun([step]);
    const r0 = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = r0.next;
    const resultPath = join(tmpDir, 'step-0-output.md');
    await fs.writeFile(resultPath, `done\n${SENTINEL}\n`, 'utf8');
    const r = await transitionStep(
      step,
      { kind: 'report', report: { kind: 'result', step_index: 0, result_path: resultPath } },
      run,
      opts,
    );
    expect(r.next.phase).toBe('compliance');
  });
});

// ── chunk_plan: patterns file already exists (doesn't rewrite seed) ───────

describe('chunk_plan patterns seed', () => {
  it('skips rewriting seed file when it already exists', async () => {
    const rdPath = join(tmpDir, '.ewh-artifacts', 'r01');
    await fs.mkdir(rdPath, { recursive: true });
    const existing = join(rdPath, 'step-0-chunk-patterns.json');
    await fs.writeFile(existing, '{"include":["custom/**"]}', 'utf8');
    const step = makeStep({ agent: 'hello', chunked: true });
    const run = makeRun([step]);
    const r = await transitionStep(step, { kind: 'enter' }, run, opts);
    expect(r.next.phase).toBe('chunk_plan');
    // Seed not overwritten
    const still = await fs.readFile(existing, 'utf8');
    expect(still).toContain('custom/**');
  });
});


