/**
 * `ewh report --run <id> --step <id> [--result <path>|--decision <y/n>|--error ...|--abort]`
 *
 * The LLM invokes this after every tool execution. We re-load state,
 * apply the reported outcome to the current step, and emit the next
 * instruction (possibly `done`). State is persisted atomically before
 * output is written.
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readRunState, writeRunState, clearActive, runDir } from '../state/store.js';
import { transitionStep, advanceRun, type TransitionOpts } from '../state/machine.js';
import { formatInstruction } from '../instruction/emit.js';
import { readTurnLogSince } from '../hooks/tool-use-log.js';
import { compareDrift } from '../hooks/drift.js';
import type { Instruction, Report, RunState } from '../state/types.js';
import { continueCleanup } from './cleanup.js';
import { continueInit } from './init.js';
import { continueDesign } from './design.js';
import { continueManage } from './manage.js';
import { continueMigrate } from './migrate.js';
import { continueExpandTools } from './expand-tools.js';
import { continueResume } from './resume.js';

export type ReportOptions = {
  projectRoot: string;
  pluginRoot: string;
  runId: string;
  stepIndex: number;
  report: Report;
};

function extractInstructedTool(instr: Instruction): string | undefined {
  if (instr.kind === 'bash') return 'Bash';
  if (instr.kind !== 'tool-call') return undefined;
  const m = /^Tool:\s+(\S+)/m.exec(instr.body);
  return m?.[1];
}

export async function runReport(opts: ReportOptions): Promise<string> {
  const run = await readRunState(opts.projectRoot, opts.runId);

  // ── drift_gate_pending resolution ─────────────────────────────────────────
  let effectiveReport = opts.report;
  if (run.drift_gate_pending) {
    if (opts.report.kind !== 'decision') {
      throw new Error('drift gate expects --decision yes or --abort');
    }
    if (opts.report.decision === 'no') {
      run.status = 'aborted';
      await writeRunState(opts.projectRoot, run);
      await clearActive(opts.projectRoot, run.run_id);
      return formatInstruction({ kind: 'done', body: `Run ${run.run_id} aborted (drift gate declined).` });
    }
    // yes → resume with stored pending_report
    const { pending_report } = run.drift_gate_pending;
    run.drift_gate_pending = undefined;
    effectiveReport = pending_report;
  }

  // ── abort ──────────────────────────────────────────────────────────────────
  if (effectiveReport.kind === 'abort') {
    run.status = 'aborted';
    await writeRunState(opts.projectRoot, run);
    await clearActive(opts.projectRoot, run.run_id);
    return formatInstruction({
      kind: 'done',
      body: `Run ${run.run_id} aborted.`,
    });
  }

  // ── drift check ───────────────────────────────────────────────────────────
  const turnLogPath = join(runDir(opts.projectRoot, run.run_id), 'turn-log.jsonl');
  const { entries: logEntries, newOffset } = await readTurnLogSince(turnLogPath, run.turn_log_offset ?? 0);
  run.turn_log_offset = newOffset;

  if (run.last_instructed_tool) {
    const driftResult = compareDrift(run.last_instructed_tool, logEntries);
    run.last_instructed_tool = undefined;
    if (driftResult !== 'ok') {
      const msg = `[ewh] drift: expected '${driftResult.expected}', saw '${driftResult.actual}'`;
      process.stderr.write(msg + '\n');
      if (run.strict) {
        run.drift_gate_pending = { pending_report: effectiveReport, mismatch: driftResult };
        await writeRunState(opts.projectRoot, run);
        return formatInstruction({
          kind: 'user-prompt',
          body: [
            `Drift detected: expected tool '${driftResult.expected}' but saw '${driftResult.actual}'.`,
            `Confirm: ewh report --run ${run.run_id} --step ${run.current_step_index} --decision yes`,
            `Abort:   ewh report --run ${run.run_id} --abort`,
          ].join('\n'),
          report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index} --decision yes`,
        });
      }
    }
  }

  const transOpts: TransitionOpts = {
    pluginRoot: opts.pluginRoot,
    projectRoot: opts.projectRoot,
    strictDrift: run.strict,
  };

  // Subcommand runs have their own continuation handlers and bypass step
  // machinery entirely.
  if (run.subcommand) {
    const instr = await dispatchSubcommandReport(run, effectiveReport, opts);
    if (instr.kind === 'done') {
      run.status = run.status === 'aborted' ? 'aborted' : 'complete';
      await writeRunState(opts.projectRoot, run);
      await clearActive(opts.projectRoot, run.run_id);
      return formatInstruction({ ...instr, report_with: undefined });
    }
    run.last_instructed_tool = extractInstructedTool(instr);
    await writeRunState(opts.projectRoot, run);
    return formatInstruction(
      instr.report_with
        ? instr
        : { ...instr, report_with: `ewh report --run ${run.run_id} --step 0` },
    );
  }

  // Pre-run manage_scripts gate: handled before normal step dispatch.
  if (run.manage_scripts_pending) {
    if (effectiveReport.kind !== 'decision') {
      throw new Error('manage_scripts gate expects --decision yes or --abort');
    }
    run.manage_scripts_pending = undefined;
    if (effectiveReport.decision === 'no') {
      run.status = 'aborted';
      await writeRunState(opts.projectRoot, run);
      await clearActive(opts.projectRoot, run.run_id);
      return formatInstruction({ kind: 'done', body: `Run ${run.run_id} aborted.` });
    }
    // yes → enter first step
    const firstStep = run.steps[0]!;
    const r = await transitionStep(firstStep, { kind: 'enter' }, run, transOpts);
    firstStep.state = r.next;
    let instr = r.instruction;
    if (instr.report_with === '__CONTINUE__' || instr.kind === 'done') {
      instr = await driveForward(run, instr, transOpts);
    }
    if (instr.kind === 'done') {
      run.status = 'complete';
      await writeRunState(opts.projectRoot, run);
      await clearActive(opts.projectRoot, run.run_id);
      return formatInstruction({ ...instr, report_with: undefined });
    }
    run.last_instructed_tool = extractInstructedTool(instr);
    await writeRunState(opts.projectRoot, run);
    return formatInstruction(
      instr.report_with
        ? instr
        : { ...instr, report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index}` },
    );
  }

  if (opts.stepIndex !== run.current_step_index) {
    throw new Error(
      `report for step ${opts.stepIndex} but run is on step ${run.current_step_index}`,
    );
  }

  const step = run.steps[run.current_step_index]!;
  const result = await transitionStep(
    step,
    { kind: 'report', report: effectiveReport },
    run,
    transOpts,
  );
  step.state = result.next;

  let instr = result.instruction;
  if (instr.report_with === '__CONTINUE__' || instr.kind === 'done') {
    instr = await driveForward(run, instr, transOpts);
  }

  if (instr.kind === 'done') {
    run.status = run.status === 'aborted' ? 'aborted' : 'complete';
    await writeRunState(opts.projectRoot, run);
    await clearActive(opts.projectRoot, run.run_id);
    return formatInstruction({ ...instr, report_with: undefined });
  }

  run.last_instructed_tool = extractInstructedTool(instr);
  await writeRunState(opts.projectRoot, run);
  return formatInstruction(
    instr.report_with
      ? instr
      : {
          ...instr,
          report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index}`,
        },
  );
}

async function dispatchSubcommandReport(
  run: RunState,
  report: Report,
  opts: ReportOptions,
): Promise<Instruction> {
  const ctx = { projectRoot: opts.projectRoot, pluginRoot: opts.pluginRoot };
  switch (run.subcommand) {
    case 'list':
      throw new Error('list subcommand is single-turn; no report expected');
    case 'cleanup':
      return continueCleanup(run, report, ctx);
    case 'init':
      return continueInit(run, report, ctx);
    case 'design':
      return continueDesign(run, report, ctx);
    case 'manage':
      return continueManage(run, report, ctx);
    case 'migrate':
      return continueMigrate(run, report, ctx);
    case 'expand-tools':
      return continueExpandTools(run, report, ctx);
    case 'resume':
      return continueResume(run, report, ctx);
    default:
      throw new Error(`unknown subcommand '${run.subcommand}' in run state`);
  }
}

async function driveForward(
  run: RunState,
  last: Instruction,
  opts: TransitionOpts,
): Promise<Instruction> {
  let current = last;
  for (let i = 0; i < 1000; i++) {
    if (current.kind === 'done') return current;
    if (current.report_with !== '__CONTINUE__') return current;
    const next = await advanceRun(run);
    if (!next) {
      return {
        kind: 'done',
        body: `Workflow '${run.workflow}' finished.`,
      };
    }
    const result = await transitionStep(next, { kind: 'enter' }, run, opts);
    next.state = result.next;
    current = result.instruction;
  }
  throw new Error(
    'dispatcher looped past 1000 transitions without emitting a visible instruction',
  );
}

/** Entrypoint wired from `src/index.ts`. */
export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      step: { type: 'string' },
      result: { type: 'string' },
      decision: { type: 'string' },
      error: { type: 'string' },
      abort: { type: 'boolean' },
      'project-root': { type: 'string' },
      'plugin-root': { type: 'string' },
      'strict': { type: 'boolean' },
    },
    strict: false,
  });
  const runId = requireStr(values.run, '--run');
  const projectRoot =
    (values['project-root'] as string | undefined) ?? process.cwd();
  const pluginRoot =
    (values['plugin-root'] as string | undefined) ??
    process.env.CLAUDE_PLUGIN_ROOT ??
    projectRoot;

  let report: Report;
  let stepIndex = -1;
  if (values.abort) {
    report = { kind: 'abort' };
  } else if (typeof values.error === 'string') {
    stepIndex = parseStepIndex(values.step);
    report = { kind: 'error', step_index: stepIndex, message: values.error };
  } else if (typeof values.decision === 'string') {
    stepIndex = parseStepIndex(values.step);
    const d = values.decision === 'yes' ? 'yes' : values.decision === 'no' ? 'no' : null;
    if (!d) throw new Error('--decision must be "yes" or "no"');
    report = { kind: 'decision', step_index: stepIndex, decision: d };
  } else {
    stepIndex = parseStepIndex(values.step);
    report = {
      kind: 'result',
      step_index: stepIndex,
      result_path:
        typeof values.result === 'string' ? values.result : undefined,
    };
  }

  const out = await runReport({ projectRoot, pluginRoot, runId, stepIndex, report });
  process.stdout.write(out);
}

function requireStr(v: unknown, flag: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required flag ${flag}`);
  }
  return v;
}

function parseStepIndex(v: unknown): number {
  const n = Number.parseInt(requireStr(v, '--step'), 10);
  if (Number.isNaN(n)) throw new Error('--step must be an integer');
  return n;
}
