/**
 * `ewh resume [<run-id>]` — re-emit the pending instruction for a paused run.
 *
 * Single-turn stateless subcommand (step 4; multi-turn disambiguation
 * gate for >1 active runs lands in step 5). Uses `scanRuns` to resolve
 * the target run:
 *
 *   - `<run-id>` provided:
 *       terminal  → print final summary, exit 0
 *       running   → re-emit pending instruction (no state mutation)
 *       unknown   → error, exit 1
 *   - `<run-id>` omitted:
 *       0 active + 0 runs      → "No runs to resume."
 *       0 active + any terminal → summary of most-recent terminal run
 *       1 active               → re-emit that run's pending instruction
 *       >1 active              → (step 5) disambiguation gate
 *
 * Re-emission strategy: deep-clone the on-disk RunState, reset the
 * current step's phase back to `pending`, and drive forward on the clone
 * until the next visible instruction. Nothing is written back to
 * `state.json`; the stored phase (gate_pending / agent_run / …) is
 * unchanged on disk, so the subsequent `ewh report` call still sees the
 * original phase and handles it correctly. Phases that cannot be safely
 * re-derived from `pending` (compliance, artifact_verify, continuation,
 * split, chunk_merge, script_propose) currently refuse resume.
 */

import { scanRuns, readRunState } from '../state/store.js';
import {
  transitionStep,
  advanceRun,
  type TransitionOpts,
} from '../state/machine.js';
import { formatInstruction } from '../instruction/emit.js';
import { formatAge } from './status.js';
import type { Instruction, RunState, StepPhase } from '../state/types.js';

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
    return reEmitCurrentInstruction(opts.projectRoot, opts.pluginRoot, opts.runId);
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
    return reEmitCurrentInstruction(
      opts.projectRoot,
      opts.pluginRoot,
      active[0]!.run_id,
    );
  }

  // Step 5 replaces this with a disambiguation gate (SubcommandState.phase
  // = 'resume_pick'). For now, surface an error so users can pick manually.
  const ids = active.map((r) => `  ${r.run_id}  ${r.workflow}`).join('\n');
  throw new Error(
    `multiple active runs; specify one:\n${ids}\n\nTry: ewh resume <run-id>`,
  );
}

export async function reEmitCurrentInstruction(
  projectRoot: string,
  pluginRoot: string,
  runId: string,
): Promise<string> {
  const run = await readRunState(projectRoot, runId);
  if (run.subcommand) {
    return formatInstruction({
      kind: 'done',
      body: [
        `Run ${runId} is a paused '${run.subcommand}' subcommand and can't be resumed.`,
        `Re-invoke 'ewh ${run.subcommand}' to start fresh, or 'ewh abort ${runId}' to drop this one.`,
      ].join('\n'),
    });
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
    return formatInstruction({ ...instr, report_with: undefined });
  }
  const withReport = instr.report_with
    ? instr
    : {
        ...instr,
        report_with: `ewh report --run ${clone.run_id} --step ${clone.current_step_index}`,
      };
  return formatInstruction(withReport);
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
