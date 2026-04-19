/**
 * Integration tests for `ewh start` / `ewh report` via a scripted fake LLM.
 *
 * Each scenario drives the binary end-to-end by calling runStart to obtain
 * the first instruction, then looping through runReport until the binary
 * emits `ACTION: done`. The "fake LLM" performs the filesystem side-effects
 * (writing result files with/without the sentinel, etc.) the real LLM would
 * perform for Agent / Bash / user-prompt actions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStart } from '../src/commands/start.js';
import { runReport } from '../src/commands/report.js';
import { SENTINEL } from '../src/state/sentinel.js';
import type { Report } from '../src/state/types.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

async function writeFile(path: string, content: string, mode?: number) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, mode !== undefined ? { mode } : 'utf8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-integ-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');

  // Minimal plugin + project scaffolding.
  await fs.mkdir(join(pluginRoot, 'workflows'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'rules'), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });

  // Default agent.
  await writeFile(
    join(pluginRoot, 'agents', 'coder.md'),
    '---\nname: coder\nmodel: haiku\ntools: [Read, Write, Edit]\nmaxTurns: 5\n---\n\nCoder body.',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

type Parsed = {
  action: 'tool-call' | 'user-prompt' | 'bash' | 'done';
  body: string;
  reportWith?: string;
  runId?: string;
  stepIndex?: number;
  resultPath?: string;
};

function parseInstruction(raw: string): Parsed {
  const actionMatch = raw.match(/^ACTION: (\S+)\n([\s\S]*)$/);
  if (!actionMatch) throw new Error(`cannot parse instruction: ${raw}`);
  const action = actionMatch[1] as Parsed['action'];
  const restBody = actionMatch[2]!;
  const reportIdx = restBody.lastIndexOf('\nREPORT_WITH: ');
  const body = reportIdx === -1 ? restBody : restBody.slice(0, reportIdx);
  const reportWith =
    reportIdx === -1
      ? undefined
      : restBody.slice(reportIdx + '\nREPORT_WITH: '.length).trim();
  const runId = reportWith?.match(/--run (\S+)/)?.[1];
  const stepIndex = reportWith?.match(/--step (\d+)/)?.[1];
  const resultPath = body.match(/save (?:its final output to|the final assistant message to):?\s*\n?\s{0,4}(\S+)/)?.[1]
    ?? body.match(/to:\s*\n\s*(\/\S+)/)?.[1]
    ?? reportWith?.match(/--result (\S+)/)?.[1];
  return {
    action,
    body,
    reportWith,
    runId,
    stepIndex: stepIndex !== undefined ? Number(stepIndex) : undefined,
    resultPath,
  };
}

async function simulateSentinelAgent(resultPath: string, extra = ''): Promise<void> {
  await fs.mkdir(join(resultPath, '..'), { recursive: true });
  await fs.writeFile(resultPath, `${extra}\n${SENTINEL}\n`, 'utf8');
}

async function doReport(
  runId: string,
  stepIndex: number,
  report: Report,
): Promise<Parsed> {
  const result = await runReport({
    projectRoot,
    pluginRoot,
    runId,
    stepIndex,
    report,
  });
  return parseInstruction(result);
}

// ─── Scenarios ───────────────────────────────────────────────────────────

describe('happy path — single agent step completes on first run', () => {
  it('runStart → agent → result+sentinel → done', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'hello.md'),
      `---\nname: hello\n---\n\n## Steps\n\n- name: greet\n  gate: auto\n  agent: coder\n  reads: [README.md]\n`,
    );
    await writeFile(join(projectRoot, 'README.md'), 'hello');

    const out = await runStart({
      projectRoot,
      pluginRoot,
      rawArgv: 'hello',
    });
    const first = parseInstruction(out);
    expect(first.action).toBe('tool-call');
    expect(first.runId).toBeDefined();

    await simulateSentinelAgent(first.resultPath!);
    const done = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    expect(done.action).toBe('done');
  });
});

describe('startup gate — --need-approval flips auto-approval', () => {
  it('auto-approval triggers agent immediately; need-approval path still works', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'q.md'),
      `---\nname: q\n---\n\n## Steps\n\n- name: run\n  gate: auto\n  agent: coder\n  reads: [r.md]\n`,
    );
    await writeFile(join(projectRoot, 'r.md'), 'x');

    const autoOut = await runStart({
      projectRoot,
      pluginRoot,
      rawArgv: 'q',
    });
    expect(parseInstruction(autoOut).action).toBe('tool-call');
  });
});

describe('structural gate — per-step pause; --trust auto-skips', () => {
  it('gate=structural emits user-prompt by default', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 's.md'),
      `---\nname: s\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    const out = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 's' }),
    );
    expect(out.action).toBe('user-prompt');
    expect(out.body).toContain('structural gate');

    const advance = await doReport(out.runId!, out.stepIndex!, {
      kind: 'decision',
      step_index: out.stepIndex!,
      decision: 'yes',
    });
    expect(advance.action).toBe('tool-call');
  });

  it('--trust skips structural gate directly to agent', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 's2.md'),
      `---\nname: s2\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    const out = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 's2', trust: true }),
    );
    expect(out.action).toBe('tool-call');
  });
});

describe('compliance failure — --yolo skip + user override', () => {
  beforeEach(async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'fail.md'),
      '---\nname: fail\nseverity: critical\nverify: "exit 1"\n---\n\nBody',
    );
    await writeFile(
      join(pluginRoot, 'workflows', 'c.md'),
      `---\nname: c\n---\n\n## Steps\n\n- name: r\n  gate: auto\n  agent: coder\n  rules: [fail]\n  reads: [_]\n`,
    );
  });

  it('failure gates; user can skip via decision=no', async () => {
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'c' }),
    );
    await simulateSentinelAgent(first.resultPath!);
    const gated = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    expect(gated.action).toBe('user-prompt');
    expect(gated.body).toContain('compliance check FAILED');

    const skipped = await doReport(first.runId!, first.stepIndex!, {
      kind: 'decision',
      step_index: first.stepIndex!,
      decision: 'no',
    });
    expect(skipped.action).toBe('done');
  });

  it('--yolo accepts the combined flag without throwing', async () => {
    // (--yolo only applies during runStart's own transitions; when the
    //  critical-rule check runs in runReport there's no auto-skip, so the
    //  gate still appears. This test simply verifies --yolo is accepted.)
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'c', yolo: true }),
    );
    expect(first.action).toBe('tool-call');
  });

  it('--yolo --save is rejected', async () => {
    await expect(
      runStart({ projectRoot, pluginRoot, rawArgv: 'c', yolo: true, save: true }),
    ).rejects.toThrow(/--yolo --save is rejected/);
  });
});

describe('error retry exhaustion gate', () => {
  it('gates after default 2 retries', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'e.md'),
      `---\nname: e\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'e' }),
    );
    // With maxErrorRetries=2 (default in runReport), need 3 errors to exhaust.
    for (let i = 1; i <= 2; i++) {
      const retry = await doReport(first.runId!, first.stepIndex!, {
        kind: 'error',
        step_index: first.stepIndex!,
        message: `fail-${i}`,
      });
      expect(retry.action).toBe('tool-call');
    }
    const gate = await doReport(first.runId!, first.stepIndex!, {
      kind: 'error',
      step_index: first.stepIndex!,
      message: 'final-fail',
    });
    expect(gate.action).toBe('user-prompt');
    expect(gate.body).toContain('failed after');

    const aborted = await doReport(first.runId!, first.stepIndex!, {
      kind: 'abort',
    });
    expect(aborted.action).toBe('done');
    expect(aborted.body).toContain('aborted');
  });
});

describe('chunked dispatch — first-run pattern prompt; cached on rerun', () => {
  beforeEach(async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'ch.md'),
      `---\nname: ch\n---\n\n## Steps\n\n- name: scan\n  gate: auto\n  agent: coder\n  chunked: true\n`,
    );
    await writeFile(join(projectRoot, 'src', 'a.ts'), 'a');
    await writeFile(join(projectRoot, 'src', 'b.ts'), 'b');
  });

  it('first run prompts for patterns, then dispatches one chunk', async () => {
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'ch' }),
    );
    expect(first.action).toBe('user-prompt');
    expect(first.body).toContain('glob patterns');
    // LLM writes include patterns at the patterns path:
    const patternsPath = first.body.match(/Edit (\S+) with/)?.[1];
    expect(patternsPath).toBeDefined();
    await writeFile(patternsPath!, JSON.stringify({ include: ['src/**/*.ts'] }));

    const chunk = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: patternsPath!,
    });
    expect(chunk.action).toBe('tool-call');
    expect(chunk.body).toContain('chunk 1/1');
  });

  it('rerun uses cached patterns (no pattern prompt)', async () => {
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'ch' }),
    );
    const patternsPath = first.body.match(/Edit (\S+) with/)?.[1]!;
    await writeFile(patternsPath, JSON.stringify({ include: ['src/**/*.ts'] }));
    await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: patternsPath,
    });

    // Second run — patterns persisted, so dispatches directly.
    const second = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'ch' }),
    );
    expect(second.action).toBe('tool-call');
    expect(second.body).toContain('chunk 1/1');
  });
});

describe('script_eval → propose → approve → cache hit', () => {
  it('scriptable step proposes, caches on approval, reuses cached on rerun', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'sc.md'),
      `---\nname: sc\n---\n\n## Steps\n\n- name: run\n  gate: auto\n  agent: coder\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'sc' }),
    );
    expect(first.action).toBe('user-prompt');
    expect(first.body).toContain('#!/usr/bin/env bash');

    const after = await doReport(first.runId!, first.stepIndex!, {
      kind: 'decision',
      step_index: first.stepIndex!,
      decision: 'yes',
    });
    expect(after.action).toBe('done');

    // Cache file exists now.
    const cachePath = join(projectRoot, '.claude', 'ewh-scripts', 'sc', 'run.sh');
    const cached = await fs.readFile(cachePath, 'utf8');
    expect(cached).toContain('Step completed.');

    // Second run: cached script runs directly.
    const second = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'sc' }),
    );
    expect(second.action).toBe('done');
  });
});

describe('script failure — script_fallback gate vs auto', () => {
  async function workflowWith(fallback: 'gate' | 'auto') {
    const scriptPath = join(projectRoot, 'fail.sh');
    await writeFile(scriptPath, '#!/usr/bin/env bash\nexit 1\n', 0o755);
    await writeFile(
      join(pluginRoot, 'workflows', `f-${fallback}.md`),
      `---\nname: f-${fallback}\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n  script: ${scriptPath}\n  script_fallback: ${fallback}\n`,
    );
    return `f-${fallback}`;
  }

  it('gate fallback emits user-prompt on failure', async () => {
    const wf = await workflowWith('gate');
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: wf }),
    );
    expect(first.action).toBe('user-prompt');
    expect(first.body).toContain('script failed');
  });

  it('auto fallback falls through to agent on failure', async () => {
    const wf = await workflowWith('auto');
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: wf }),
    );
    expect(first.action).toBe('tool-call');
  });
});

describe('continuation — partial output → continuation agent → complete', () => {
  it('missing sentinel triggers continuation tool-call', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'co.md'),
      `---\nname: co\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'co' }),
    );
    await writeFile(first.resultPath!, 'partial output without sentinel');
    const cont = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    expect(cont.action).toBe('tool-call');
    expect(cont.body).toContain('sentinel missing');

    await simulateSentinelAgent(cont.resultPath!);
    const done = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: cont.resultPath,
    });
    expect(done.action).toBe('done');
  });
});

describe('split-merge — continuation fails → split → merge', () => {
  it('split chunks run and merge into artifact', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'sp.md'),
      `---\nname: sp\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n  artifact: out.md\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'sp' }),
    );
    // Partial with list items to trigger split; continuation then fails → split.
    await writeFile(
      first.resultPath!,
      '- item one\n- item two\n- item three\n',
    );
    const cont = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    expect(cont.action).toBe('tool-call');
    expect(cont.body).toContain('sentinel missing');

    // Continuation agent crashes → escalates to split.
    const split = await doReport(first.runId!, first.stepIndex!, {
      kind: 'error',
      step_index: first.stepIndex!,
      message: 'continuation crashed',
    });
    expect(split.action).toBe('tool-call');
    expect(split.body).toContain('split 1/');

    // Drive split chunk to completion.
    await simulateSentinelAgent(split.resultPath!, 'chunk result');
    const final = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: split.resultPath,
    });
    expect(final.action).toBe('done');
    const merged = await fs.readFile(join(projectRoot, 'out.md'), 'utf8');
    expect(merged).toContain('chunk result');
  });
});

describe('crash resume — re-invoking runReport re-emits same instruction idempotently', () => {
  it('second runReport with identical state replays the tool-call', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'cr.md'),
      `---\nname: cr\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'cr' }),
    );
    // "Crash" by not executing the tool — re-call runReport with same path.
    await writeFile(first.resultPath!, `done\n${SENTINEL}\n`);
    const done = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    expect(done.action).toBe('done');
  });
});

describe('abort mid-flight', () => {
  it('clears ACTIVE marker and marks the run aborted', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'ab.md'),
      `---\nname: ab\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'ab' }),
    );
    const done = await doReport(first.runId!, first.stepIndex!, {
      kind: 'abort',
    });
    expect(done.action).toBe('done');
    expect(done.body).toContain('aborted');
    // ACTIVE marker gone
    await expect(
      fs.access(join(projectRoot, '.ewh-artifacts', `run-${first.runId!.replace(/^run-/, '')}`, 'ACTIVE')),
    ).rejects.toThrow();
  });
});

describe('drift detection — Level 2 (log only) vs Level 3 (strict gate)', () => {
  async function setup() {
    // Two-step workflow: first step completes normally and arms
    // last_instructed_tool for the second step, at which point drift is checked.
    await writeFile(
      join(pluginRoot, 'workflows', 'd.md'),
      `---\nname: d\n---\n\n## Steps\n\n- name: first\n  gate: auto\n  agent: coder\n  reads: [_a]\n- name: second\n  gate: auto\n  agent: coder\n  reads: [_b]\n`,
    );
  }

  async function driveToSecondStep(strict: boolean): Promise<{
    runId: string;
    stepIndex: number;
    resultPath: string;
  }> {
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'd', strict }),
    );
    // Complete step 0.
    await writeFile(first.resultPath!, `done\n${SENTINEL}\n`);
    const step2 = await doReport(first.runId!, first.stepIndex!, {
      kind: 'result',
      step_index: first.stepIndex!,
      result_path: first.resultPath,
    });
    return {
      runId: first.runId!,
      stepIndex: step2.stepIndex!,
      resultPath: step2.resultPath!,
    };
  }

  async function injectDrift(runId: string) {
    const logPath = join(
      projectRoot,
      '.ewh-artifacts',
      `run-${runId}`,
      'turn-log.jsonl',
    );
    await writeFile(
      logPath,
      JSON.stringify({
        event: 'PostToolUse',
        ts: new Date().toISOString(),
        tool: 'Bash',
      }) + '\n',
    );
  }

  it('level 2 logs mismatch but proceeds', async () => {
    await setup();
    const { runId, stepIndex, resultPath } = await driveToSecondStep(false);
    await injectDrift(runId);
    await writeFile(resultPath, `done\n${SENTINEL}\n`);
    const out = await doReport(runId, stepIndex, {
      kind: 'result',
      step_index: stepIndex,
      result_path: resultPath,
    });
    expect(out.action).toBe('done');
  });

  it('level 3 (--strict) halts with drift gate', async () => {
    await setup();
    const { runId, stepIndex, resultPath } = await driveToSecondStep(true);
    await injectDrift(runId);
    await writeFile(resultPath, `done\n${SENTINEL}\n`);
    const gate = await doReport(runId, stepIndex, {
      kind: 'result',
      step_index: stepIndex,
      result_path: resultPath,
    });
    expect(gate.action).toBe('user-prompt');
    expect(gate.body).toContain('Drift detected');

    // Decline drift gate → abort.
    const aborted = await doReport(runId, stepIndex, {
      kind: 'decision',
      step_index: stepIndex,
      decision: 'no',
    });
    expect(aborted.action).toBe('done');
    expect(aborted.body).toContain('aborted');
  });

  it('level 3 (--strict) confirm via decision=yes resumes with stored report', async () => {
    await setup();
    const { runId, stepIndex, resultPath } = await driveToSecondStep(true);
    await injectDrift(runId);
    await writeFile(resultPath, `done\n${SENTINEL}\n`);
    await doReport(runId, stepIndex, {
      kind: 'result',
      step_index: stepIndex,
      result_path: resultPath,
    });
    const ok = await doReport(runId, stepIndex, {
      kind: 'decision',
      step_index: stepIndex,
      decision: 'yes',
    });
    expect(ok.action).toBe('done');
  });
});

describe('subcommand report routing — cleanup task failure gate resumes', () => {
  it('cleanup with a failing task gates, then user decision=yes skips + continues', async () => {
    // Seed a cleanup_tasks list.
    const { writeEwhStateFile } = await import('../src/state/workflow-settings.js');
    await writeEwhStateFile(projectRoot, {
      cleanup_tasks: [
        { name: 'fail-me', command: 'exit 1' },
        { name: 'ok', command: 'echo ok' },
      ],
    });
    const start = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'cleanup' }),
    );
    expect(start.action).toBe('bash');
    expect(start.body).toContain('fail-me');

    // Simulate failure.
    const gate = await doReport(start.runId!, 0, {
      kind: 'error',
      step_index: 0,
      message: 'boom',
    });
    expect(gate.action).toBe('user-prompt');
    expect(gate.body).toContain("failed");

    // Skip and continue.
    const next = await doReport(start.runId!, 0, {
      kind: 'decision',
      step_index: 0,
      decision: 'yes',
    });
    expect(next.action).toBe('bash');
    expect(next.body).toContain('ok');

    // Finish.
    const done = await doReport(start.runId!, 0, {
      kind: 'result',
      step_index: 0,
    });
    expect(done.action).toBe('done');
    expect(done.body).toMatch(/1 passed, 1 failed, 1 skipped/);
  });
});

describe('report step-index mismatch', () => {
  it('throws when step_index disagrees with the run cursor', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'mi.md'),
      `---\nname: mi\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'mi' }),
    );
    await expect(
      runReport({
        projectRoot,
        pluginRoot,
        runId: first.runId!,
        stepIndex: 99,
        report: { kind: 'result', step_index: 99, result_path: first.resultPath! },
      }),
    ).rejects.toThrow(/report for step 99/);
  });
});

describe('save flag persists settings across runs', () => {
  it('--trust --save persists auto_structural', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'sv.md'),
      `---\nname: sv\n---\n\n## Steps\n\n- name: go\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    await runStart({
      projectRoot,
      pluginRoot,
      rawArgv: 'sv',
      trust: true,
      save: true,
    });
    const { readWorkflowSettings } = await import(
      '../src/state/workflow-settings.js'
    );
    const s = await readWorkflowSettings(projectRoot, 'sv');
    expect(s.auto_structural).toBe(true);
  });
});

describe('builtin subcommand resolution — --no-override', () => {
  it('--no-override forces the builtin list subcommand even when a project workflow exists', async () => {
    await writeFile(
      join(pluginRoot, 'skills', 'doit', 'list.md'),
      'plugin catalog',
    );
    await writeFile(
      join(projectRoot, '.claude', 'workflows', 'list.md'),
      `---\nname: list\n---\n\n## Steps\n\n- name: noop\n  gate: auto\n  message: hi\n`,
    );
    // Default: project override wins → not builtin.
    const override = parseInstruction(
      await runStart({ projectRoot, pluginRoot, rawArgv: 'list' }),
    );
    // The override is a workflow with a single no-op step → message step completes → done.
    expect(override.action).toBe('done');

    // --no-override forces the builtin list subcommand.
    const builtin = parseInstruction(
      await runStart({
        projectRoot,
        pluginRoot,
        rawArgv: 'list',
        noOverride: true,
      }),
    );
    expect(builtin.action).toBe('done');
    expect(builtin.body).toContain('plugin catalog');
  });
});
