import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runResume } from '../src/commands/resume.js';
import { runStart } from '../src/commands/start.js';
import { runReport } from '../src/commands/report.js';
import {
  writeRunState,
  markActive,
  readRunState,
  activeMarker,
} from '../src/state/store.js';
import type { RunState } from '../src/state/types.js';

/**
 * A minimal end-to-end test harness mirroring the integration.test.ts
 * pattern: scaffold plugin + project dirs, write a workflow + agent,
 * then drive `runStart`. We use `runStart` rather than hand-rolling a
 * RunState so the resulting step state is produced by the real state
 * machine (gate_pending prompt, agent_run prompt_path, etc.).
 */
async function writeFileEnsuring(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

function parseAction(raw: string): {
  action: string;
  runId?: string;
  body: string;
  reportWith?: string;
} {
  const m = raw.match(/^ACTION: (\S+)\n([\s\S]*)$/);
  if (!m) throw new Error(`cannot parse: ${raw}`);
  const rest = m[2]!;
  const idx = rest.lastIndexOf('\nREPORT_WITH: ');
  const body = idx === -1 ? rest : rest.slice(0, idx);
  const reportWith =
    idx === -1 ? undefined : rest.slice(idx + '\nREPORT_WITH: '.length).trim();
  const runId = reportWith?.match(/--run (\S+)/)?.[1] ?? body.match(/--run (\S+)/)?.[1];
  return { action: m[1]!, runId, body, reportWith };
}

// A low-level RunState builder for cases where we don't need the full
// state machine (no-active / terminal runs).
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
    ],
    started_at: now,
    updated_at: now,
    status: 'running',
    ...overrides,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

describe('runResume — no-active and terminal branches', () => {
  let projectRoot: string;
  const pluginRoot = '/unused-plugin-root';

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(join(tmpdir(), 'ewh-resume-'));
  });
  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('no runs at all → "No runs to resume."', async () => {
    const out = await runResume({ projectRoot, pluginRoot });
    expect(out).toContain('No runs to resume.');
  });

  it('no active runs, one terminal run → summary of most-recent terminal', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'donerun0', status: 'complete', updated_at: '2026-04-19T11:00:00Z' }),
    );
    const out = await runResume({ projectRoot, pluginRoot });
    expect(out).toContain('Run donerun0 is complete (add-feature,');
  });

  it('no active runs, two terminal runs → picks most-recent by updated_at', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'oldaaaaa', status: 'aborted', updated_at: '2026-01-01T00:00:00Z' }),
    );
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'newbbbbb', status: 'complete', updated_at: '2026-03-01T00:00:00Z' }),
    );
    // Overwrite updated_at since writeRunState bumps it.
    const fix = async (id: string, ts: string) => {
      const p = join(projectRoot, '.ewh-artifacts', `run-${id}`, 'state.json');
      const st = JSON.parse(await fs.readFile(p, 'utf8'));
      st.updated_at = ts;
      await fs.writeFile(p, JSON.stringify(st));
    };
    await fix('oldaaaaa', '2026-01-01T00:00:00Z');
    await fix('newbbbbb', '2026-03-01T00:00:00Z');

    const out = await runResume({ projectRoot, pluginRoot });
    expect(out).toContain('newbbbbb');
    expect(out).not.toContain('oldaaaaa');
  });

  it('explicit <run-id>: unknown id errors', async () => {
    await expect(
      runResume({ projectRoot, pluginRoot, runId: 'notthere' }),
    ).rejects.toThrow(/run not found: notthere/);
  });

  it('explicit <run-id>: terminal run → summary (exit 0)', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({ run_id: 'donerun1', status: 'complete' }),
    );
    const out = await runResume({
      projectRoot,
      pluginRoot,
      runId: 'donerun1',
    });
    expect(out).toContain('Run donerun1 is complete');
  });

  it('subcommand runs refuse to resume, suggest re-invoke', async () => {
    await writeRunState(
      projectRoot,
      fakeRun({
        run_id: 'subrun00',
        workflow: 'init',
        subcommand: 'init',
        status: 'running',
      }),
    );
    await markActive(projectRoot, 'subrun00');
    const out = await runResume({ projectRoot, pluginRoot });
    expect(out).toContain("paused 'init' subcommand");
    expect(out).toContain("Re-invoke 'ewh init'");
    // State on disk is unchanged.
    const state = await readRunState(projectRoot, 'subrun00');
    expect(state.status).toBe('running');
  });

  it('omitted <run-id>: >1 active runs → disambiguation gate prompt + new resume subcommand run', async () => {
    await writeRunState(projectRoot, fakeRun({ run_id: 'active01' }));
    await markActive(projectRoot, 'active01');
    await writeRunState(projectRoot, fakeRun({ run_id: 'active02' }));
    await markActive(projectRoot, 'active02');

    const out = await runResume({ projectRoot, pluginRoot });
    const parsed = parseAction(out);
    expect(parsed.action).toBe('user-prompt');
    expect(parsed.body).toContain('Multiple active runs');
    expect(parsed.body).toContain('active01');
    expect(parsed.body).toContain('active02');
    expect(parsed.body).toMatch(/write the chosen id/);

    // A fresh resume subcommand run was created and is the one in
    // report_with, not either of the candidates.
    const resumeRunId = parsed.runId!;
    expect(resumeRunId).not.toBe('active01');
    expect(resumeRunId).not.toBe('active02');
    const resumeState = await readRunState(projectRoot, resumeRunId);
    expect(resumeState.subcommand).toBe('resume');
    expect(resumeState.status).toBe('running');
    expect(resumeState.subcommand_state).toMatchObject({
      kind: 'resume',
      phase: 'resume_pick',
      active_ids: expect.arrayContaining(['active01', 'active02']),
    });
    expect(await fileExists(activeMarker(projectRoot, resumeRunId))).toBe(true);

    // Candidate runs are untouched.
    expect((await readRunState(projectRoot, 'active01')).status).toBe('running');
    expect((await readRunState(projectRoot, 'active02')).status).toBe('running');
  });
});

describe('runResume — re-emission of workflow runs', () => {
  let tmp: string;
  let projectRoot: string;
  let pluginRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'ewh-resume-e2e-'));
    pluginRoot = join(tmp, 'plugin');
    projectRoot = join(tmp, 'project');
    await fs.mkdir(join(pluginRoot, 'workflows'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'rules'), { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await writeFileEnsuring(
      join(pluginRoot, 'agents', 'coder.md'),
      '---\nname: coder\nmodel: haiku\ntools: [Read, Write, Edit]\nmaxTurns: 5\n---\n\nCoder.',
    );
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('gate_pending: re-emits the same structural-gate prompt without mutating state.json', async () => {
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'g.md'),
      `---\nname: g\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseAction(await runStart({ projectRoot, pluginRoot, rawArgv: 'g' }));
    expect(first.action).toBe('user-prompt');
    expect(first.body).toContain('structural gate');
    const runId = first.runId!;

    // Capture on-disk state before resume.
    const before = await readRunState(projectRoot, runId);
    const beforeJson = JSON.stringify(before);

    const out = await runResume({ projectRoot, pluginRoot, runId });
    const parsed = parseAction(out);
    expect(parsed.action).toBe('user-prompt');
    expect(parsed.body).toContain('structural gate');
    expect(parsed.body).toContain(first.body.split('\n')[0]);

    // State on disk untouched.
    const after = await readRunState(projectRoot, runId);
    expect(JSON.stringify(after)).toBe(beforeJson);
    // ACTIVE marker still present.
    expect(await fileExists(activeMarker(projectRoot, runId))).toBe(true);
  });

  it('agent_run: re-emits the same agent tool-call referencing the same prompt path', async () => {
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'a.md'),
      `---\nname: a\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseAction(await runStart({ projectRoot, pluginRoot, rawArgv: 'a' }));
    expect(first.action).toBe('tool-call');
    const runId = first.runId!;

    const before = await readRunState(projectRoot, runId);
    const promptPathBefore = (before.steps[0]!.state as { prompt_path?: string }).prompt_path;
    const beforeJson = JSON.stringify(before);

    const out = await runResume({ projectRoot, pluginRoot, runId });
    const parsed = parseAction(out);
    expect(parsed.action).toBe('tool-call');
    // The re-emitted tool-call should reference the same prompt path.
    expect(promptPathBefore).toBeDefined();
    expect(parsed.body).toContain(promptPathBefore!);

    // state.json untouched.
    const after = await readRunState(projectRoot, runId);
    expect(JSON.stringify(after)).toBe(beforeJson);
  });

  it('single active run, no <run-id>: picks it automatically and re-emits', async () => {
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'q.md'),
      `---\nname: q\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    const first = parseAction(await runStart({ projectRoot, pluginRoot, rawArgv: 'q' }));
    const runId = first.runId!;

    const out = await runResume({ projectRoot, pluginRoot });
    const parsed = parseAction(out);
    expect(parsed.action).toBe('user-prompt');
    expect(parsed.runId).toBe(runId);
  });

  it('>1 active: pick gate → report --result <id> → re-emits chosen run', async () => {
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'w1.md'),
      `---\nname: w1\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'w2.md'),
      `---\nname: w2\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    const run1 = parseAction(await runStart({ projectRoot, pluginRoot, rawArgv: 'w1' }));
    const run2 = parseAction(await runStart({ projectRoot, pluginRoot, rawArgv: 'w2' }));
    expect(run1.runId).toBeDefined();
    expect(run2.runId).toBeDefined();

    // Resume with >1 active → pick gate.
    const gate = parseAction(await runResume({ projectRoot, pluginRoot }));
    expect(gate.action).toBe('user-prompt');
    expect(gate.body).toContain('Multiple active runs');
    const resumeRunId = gate.runId!;
    const pickPath = gate.reportWith!.match(/--result (\S+)/)![1]!;

    // LLM writes the chosen run-id to the pick file.
    await fs.writeFile(pickPath, `${run2.runId}\n`, 'utf8');

    // Report the pick. continueResume should close the outer resume run
    // and emit run2's pending gate prompt.
    const picked = parseAction(
      await runReport({
        projectRoot,
        pluginRoot,
        runId: resumeRunId,
        stepIndex: 0,
        report: { kind: 'result', step_index: 0, result_path: pickPath },
      }),
    );
    expect(picked.action).toBe('user-prompt');
    expect(picked.body).toContain('structural gate');
    // report_with is scoped to the picked run, NOT the resume wrapper.
    expect(picked.runId).toBe(run2.runId);

    // Outer resume run is complete and no longer active.
    const outer = await readRunState(projectRoot, resumeRunId);
    expect(outer.status).toBe('complete');
    expect(await fileExists(activeMarker(projectRoot, resumeRunId))).toBe(false);

    // Picked run is untouched (still running, state.json unchanged).
    const pickedState = await readRunState(projectRoot, run2.runId!);
    expect(pickedState.status).toBe('running');
    expect(await fileExists(activeMarker(projectRoot, run2.runId!))).toBe(true);
    // Non-picked run is also untouched.
    expect((await readRunState(projectRoot, run1.runId!)).status).toBe('running');
  });

  it('>1 active: report with a non-active run-id errors', async () => {
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'w3.md'),
      `---\nname: w3\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    await writeFileEnsuring(
      join(pluginRoot, 'workflows', 'w4.md'),
      `---\nname: w4\n---\n\n## Steps\n\n- name: review\n  gate: structural\n  agent: coder\n  reads: [_]\n`,
    );
    await runStart({ projectRoot, pluginRoot, rawArgv: 'w3' });
    await runStart({ projectRoot, pluginRoot, rawArgv: 'w4' });

    const gate = parseAction(await runResume({ projectRoot, pluginRoot }));
    const resumeRunId = gate.runId!;
    const pickPath = gate.reportWith!.match(/--result (\S+)/)![1]!;

    await fs.writeFile(pickPath, 'bogus-id\n', 'utf8');

    await expect(
      runReport({
        projectRoot,
        pluginRoot,
        runId: resumeRunId,
        stepIndex: 0,
        report: { kind: 'result', step_index: 0, result_path: pickPath },
      }),
    ).rejects.toThrow(/not in the active run list/);
  });
});
