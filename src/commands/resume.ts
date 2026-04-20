/**
 * `ewh resume [<run-id>]` — re-emit the pending instruction for a paused run.
 *
 * Stateless when 0 or 1 active runs exist; multi-turn disambiguation gate
 * when >1 active runs exist.
 *
 *   - `<run-id>` provided:
 *       terminal  → print final summary, exit 0
 *       running   → re-emit pending instruction (no state mutation)
 *       unknown   → error, exit 1
 *   - `<run-id>` omitted:
 *       0 active + 0 runs      → "No runs to resume."
 *       0 active + any terminal → summary of most-recent terminal run
 *       1 active               → re-emit that run's pending instruction
 *       >1 active              → emit a disambiguation gate (subcommand
 *                                state `resume_pick`); user writes the
 *                                chosen run-id to a scratch file and
 *                                reports `--result <path>`.
 *
 * Re-emission strategy: deep-clone the target RunState, reset the
 * current step's phase back to `pending`, and drive forward on the
 * clone until the next visible instruction. Nothing is written back to
 * the chosen run's `state.json`; its stored phase remains unchanged so
 * the next `ewh report` against it handles the original phase
 * correctly. Phases that can't be safely re-derived from `pending`
 * (compliance, artifact_verify, continuation, split, chunk_merge,
 * script_propose) currently refuse resume.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  scanRuns,
  readRunState,
  writeRunState,
  markActive,
  clearActive,
  newRunId,
  runDir,
  type RunSummary,
} from '../state/store.js';
import {
  transitionStep,
  advanceRun,
  type TransitionOpts,
} from '../state/machine.js';
import { formatInstruction } from '../instruction/emit.js';
import { formatAge } from './status.js';
import type {
  Instruction,
  Report,
  RunState,
  StepPhase,
  SubcommandState,
} from '../state/types.js';

export type ResumeOptions = {
  projectRoot: string;
  pluginRoot: string;
  /** Positional `<run-id>` from argv, if any. */
  runId?: string;
};

/**
 * Step phases whose `pending`-entry logic reliably reproduces the
 * originally-emitted instruction. Other phases (mid-recovery,
 * post-agent checks) would require phase-specific replay logic and
 * currently refuse resume with an error.
 */
const RESUMABLE_PHASES: ReadonlySet<StepPhase> = new Set<StepPhase>([
  'pending',
  'gate_pending',
  'agent_run',
  'script_eval',
  'script_run',
]);

export async function runResume(opts: ResumeOptions): Promise<string> {
  const runs = await scanRuns(opts.projectRoot);
  const now = new Date();

  if (opts.runId !== undefined) {
    const match = runs.find((r) => r.run_id === opts.runId);
    if (!match) {
      throw new Error(`run not found: ${opts.runId}`);
    }
    if (match.status !== 'running') {
      const state = await readRunState(opts.projectRoot, opts.runId);
      return formatInstruction({
        kind: 'done',
        body: formatTerminalSummaryBody(state, now),
      });
    }
    return formatInstruction(
      await buildResumeInstruction(opts.projectRoot, opts.pluginRoot, opts.runId),
    );
  }

  const active = runs.filter((r) => r.is_active && r.status === 'running');
  if (active.length === 0) {
    const terminal = runs.find((r) => r.status !== 'running');
    if (!terminal) {
      return formatInstruction({ kind: 'done', body: 'No runs to resume.' });
    }
    const state = await readRunState(opts.projectRoot, terminal.run_id);
    return formatInstruction({
      kind: 'done',
      body: formatTerminalSummaryBody(state, now),
    });
  }
  if (active.length === 1) {
    return formatInstruction(
      await buildResumeInstruction(opts.projectRoot, opts.pluginRoot, active[0]!.run_id),
    );
  }
  return emitResumePickGate(opts.projectRoot, active, now);
}

// Legacy name kept for any external callers; thin wrapper over buildResumeInstruction.
export async function reEmitCurrentInstruction(
  projectRoot: string,
  pluginRoot: string,
  runId: string,
): Promise<string> {
  return formatInstruction(
    await buildResumeInstruction(projectRoot, pluginRoot, runId),
  );
}

/**
 * Core re-emission logic as an Instruction (not yet formatted). Used
 * directly by `continueResume` so it can plug the instruction into the
 * outer subcommand-dispatch response without double-formatting.
 */
async function buildResumeInstruction(
  projectRoot: string,
  pluginRoot: string,
  runId: string,
): Promise<Instruction> {
  const run = await readRunState(projectRoot, runId);
  if (run.subcommand) {
    return {
      kind: 'done',
      body: [
        `Run ${runId} is a paused '${run.subcommand}' subcommand and can't be resumed.`,
        `Re-invoke 'ewh ${run.subcommand}' to start fresh, or 'ewh abort ${runId}' to drop this one.`,
      ].join('\n'),
    };
  }
  const step = run.steps[run.current_step_index];
  if (!step) {
    throw new Error(`run ${runId} has no step at index ${run.current_step_index}`);
  }
  const phase = step.state.phase;
  if (!RESUMABLE_PHASES.has(phase)) {
    throw new Error(
      `resume not supported for step phase '${phase}' on run ${runId}; consider 'ewh abort ${runId}'`,
    );
  }

  // Deep-clone so nothing we do here persists — neither state.json nor
  // the turn-log offset changes. Side-effect files written by re-entry
  // (prompt file, script evaluation probes) are idempotent in content.
  const clone = JSON.parse(JSON.stringify(run)) as RunState;
  clone.steps[clone.current_step_index]!.state = { phase: 'pending' };

  const transOpts: TransitionOpts = {
    pluginRoot,
    projectRoot,
    strictDrift: clone.strict,
  };
  const instr = await driveUntilVisibleClone(clone, transOpts);

  if (instr.kind === 'done') {
    return { ...instr, report_with: undefined };
  }
  if (instr.report_with) return instr;
  return {
    ...instr,
    report_with: `ewh report --run ${clone.run_id} --step ${clone.current_step_index}`,
  };
}

/**
 * Emit the disambiguation gate when >1 active runs exist. Creates a
 * new "resume" subcommand run that persists the list of candidates in
 * `subcommand_state.phase = 'resume_pick'`. The LLM writes the chosen
 * run-id to the scratch file and reports `--result <path>`; the
 * `continueResume` handler then re-emits the chosen run's pending
 * instruction.
 */
async function emitResumePickGate(
  projectRoot: string,
  active: RunSummary[],
  now: Date,
): Promise<string> {
  const resumeRunId = newRunId();
  const rd = runDir(projectRoot, resumeRunId);
  await fs.mkdir(rd, { recursive: true });
  const pickPath = join(rd, 'pick.txt');

  const subState: Extract<SubcommandState, { kind: 'resume' }> = {
    kind: 'resume',
    phase: 'resume_pick',
    active_ids: active.map((r) => r.run_id),
    pick_path: pickPath,
  };

  const nowIso = new Date().toISOString();
  const run: RunState = {
    run_id: resumeRunId,
    workflow: 'resume',
    raw_argv: 'resume',
    current_step_index: 0,
    steps: [],
    started_at: nowIso,
    updated_at: nowIso,
    status: 'running',
    subcommand: 'resume',
    subcommand_state: subState,
  };
  await markActive(projectRoot, resumeRunId);
  await writeRunState(projectRoot, run);

  const listing = active
    .map(
      (r) =>
        `  ${r.run_id}  ${r.workflow}  step-${r.current_step_index + 1}/${r.total_steps || '?'}  ${r.current_phase}  ${formatAge(r.updated_at, now)}`,
    )
    .join('\n');

  const body = [
    'Multiple active runs — which should resume?',
    '',
    listing,
    '',
    'Ask the user which run-id to resume, then write the chosen id (no',
    'prose, no quotes) to:',
    `  ${pickPath}`,
    '',
    `Then: ewh report --run ${resumeRunId} --step 0 --result ${pickPath}`,
  ].join('\n');

  return formatInstruction({
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${resumeRunId} --step 0 --result ${pickPath}`,
  });
}

/**
 * Handle the report from the disambiguation gate. Reads the chosen
 * run-id from the scratch file, validates it against the candidate
 * list, closes out the outer resume run, and re-emits the chosen
 * run's pending instruction with its own `report_with` pointing at the
 * chosen run (not the outer resume wrapper).
 */
export async function continueResume(
  run: RunState,
  report: Report,
  ctx: { projectRoot: string; pluginRoot: string },
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'resume') {
    throw new Error("resume continuation: subcommand_state is not 'resume'");
  }
  if (sub.phase !== 'resume_pick') {
    throw new Error(`resume: unhandled phase '${(sub as { phase: string }).phase}'`);
  }
  if (report.kind === 'error') {
    throw new Error(`resume_pick: ${report.message}`);
  }
  if (report.kind !== 'result' || !report.result_path) {
    throw new Error('resume_pick: expected --result <path>');
  }
  const raw = (await fs.readFile(report.result_path, 'utf8')).trim();
  if (!sub.active_ids.includes(raw)) {
    throw new Error(
      `'${raw}' is not in the active run list; expected one of: ${sub.active_ids.join(', ')}`,
    );
  }

  // Close out the outer resume wrapper run before re-emitting, so we
  // don't leave it hanging in `running` state with a stale ACTIVE
  // marker. `run.status = 'complete'` persists via `writeRunState` in
  // `runReport`'s dispatch block.
  run.subcommand_state = undefined;
  run.status = 'complete';
  await clearActive(ctx.projectRoot, run.run_id);

  return buildResumeInstruction(ctx.projectRoot, ctx.pluginRoot, raw);
}

async function driveUntilVisibleClone(
  run: RunState,
  opts: TransitionOpts,
): Promise<Instruction> {
  for (let i = 0; i < 1000; i++) {
    const step = run.steps[run.current_step_index]!;
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = result.next;
    const instr = result.instruction;
    if (instr.kind === 'done') return instr;
    if (instr.report_with === '__CONTINUE__') {
      const next = await advanceRun(run);
      if (!next) {
        return { kind: 'done', body: `Workflow '${run.workflow}' finished.` };
      }
      continue;
    }
    return instr;
  }
  throw new Error(
    'resume: looped past 1000 transitions without emitting a visible instruction',
  );
}

function formatTerminalSummaryBody(run: RunState, now: Date): string {
  const age = formatAge(run.updated_at, now);
  return `Run ${run.run_id} is ${run.status} (${run.workflow}, ${age}).`;
}
