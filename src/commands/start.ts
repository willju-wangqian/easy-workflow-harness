/**
 * `ewh start "<raw argv>"` — begin a new run.
 *
 * Resolves the workflow, initialises RunState, marks the run active,
 * drives through any auto-completing steps, and emits the first instruction.
 * Output goes to stdout; errors to stderr with a non-zero exit.
 *
 * Name resolution (per spec §Migration Path):
 *   1. project override  — `.claude/workflows/<name>.md`
 *   2. builtin subcommand — list / init / cleanup / create / expand-tools
 *   3. plugin workflow    — `workflows/<name>.md`
 *
 * `--no-override` forces a builtin subcommand when a same-name project
 * workflow exists.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeRunState, markActive, newRunId, clearActive } from '../state/store.js';
import { listCachedScripts } from '../scripts/cache.js';
import {
  loadWorkflow,
  resolveWorkflowPath,
} from '../workflow/parse.js';
import { transitionStep, advanceRun, type TransitionOpts } from '../state/machine.js';
import { readWorkflowSettings, writeWorkflowSettings } from '../state/workflow-settings.js';
import { formatInstruction } from '../instruction/emit.js';
import type { Instruction, RunState, SubcommandState } from '../state/types.js';
import { buildListInstruction } from './list.js';
import { startCleanup } from './cleanup.js';
import { startInit } from './init.js';
import { startCreate } from './create.js';
import { startExpandTools } from './expand-tools.js';

export const BUILTIN_SUBCOMMANDS = ['list', 'init', 'cleanup', 'create', 'expand-tools'] as const;
export type BuiltinSubcommand = (typeof BUILTIN_SUBCOMMANDS)[number];

export type StartOptions = {
  projectRoot: string;
  pluginRoot: string;
  rawArgv: string;
  /** --trust: auto-approve structural gates this run */
  trust?: boolean;
  /** --yolo: --trust + auto-skip compliance (never persisted) */
  yolo?: boolean;
  /** --max-retries N: override max_error_retries for this run */
  maxRetries?: number;
  /** --save: persist applied flag values to workflow_settings */
  save?: boolean;
  /** --manage-scripts: list cached scripts for the workflow and gate before first step */
  manageScripts?: boolean;
  /** --strict: enable strict drift detection for this run */
  strict?: boolean;
  /** --no-override: force builtin subcommand when a same-name project workflow exists */
  noOverride?: boolean;
  /** --manage-tasks: for `cleanup`, drop into task-management flow */
  manageTasks?: boolean;
};

export async function runStart(opts: StartOptions): Promise<string> {
  if (opts.yolo && opts.save) {
    throw new Error('--yolo --save is rejected: compliance auto-skip cannot be persisted');
  }

  const parsed = parseStartArgv(opts.rawArgv);
  const inlineFlags = collectInlineFlags(parsed.rest);
  const noOverride = opts.noOverride ?? inlineFlags.has('no-override');
  const manageTasks = opts.manageTasks ?? inlineFlags.has('manage-tasks');

  // Name resolution (spec §Migration Path):
  //   project override  → builtin subcommand (with --no-override) → plugin workflow
  const name = parsed.workflow;
  if (isBuiltinSubcommand(name)) {
    const projectOverridePath = join(
      opts.projectRoot,
      '.claude',
      'workflows',
      `${name}.md`,
    );
    const hasProjectOverride = await fileExists(projectOverridePath);
    if (noOverride || !hasProjectOverride) {
      return startSubcommandRun(name, stripFlags(parsed.rest), opts, manageTasks);
    }
  }

  const workflowPath = await resolveWorkflowPath(
    opts.projectRoot,
    opts.pluginRoot,
    parsed.workflow,
  );
  const wf = await loadWorkflow(workflowPath);

  const settings = await readWorkflowSettings(opts.projectRoot, wf.name);

  const autoStructural = !!(opts.yolo || opts.trust || settings.auto_structural);
  const autoCompliance = !!opts.yolo;
  const maxErrorRetries = opts.maxRetries ?? settings.max_error_retries;

  if (opts.save) {
    await writeWorkflowSettings(opts.projectRoot, wf.name, {
      auto_structural: autoStructural,
      max_error_retries: maxErrorRetries,
    });
  }

  const run: RunState = {
    run_id: newRunId(),
    workflow: wf.name,
    raw_argv: opts.rawArgv,
    current_step_index: 0,
    steps: wf.steps,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    strict: opts.strict ?? false,
  };
  await markActive(opts.projectRoot, run.run_id);

  if (opts.manageScripts) {
    const scripts = await listCachedScripts(opts.projectRoot, wf.name);
    if (scripts.length > 0) {
      run.manage_scripts_pending = true;
      await writeRunState(opts.projectRoot, run);
      const scriptList = scripts
        .map((s) => `  ${s.stepName}: ${s.path}`)
        .join('\n');
      const instr: Instruction = {
        kind: 'user-prompt',
        body: [
          `Workflow '${wf.name}' has ${scripts.length} cached script(s):`,
          scriptList,
          ``,
          `To delete a script, remove its .sh (and .hash) file, then re-run.`,
          `To proceed:  ewh report --run ${run.run_id} --step 0 --decision yes`,
          `To abort:    ewh report --run ${run.run_id} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
      };
      return formatInstruction(instr);
    }
  }

  const transOpts: TransitionOpts = {
    pluginRoot: opts.pluginRoot,
    projectRoot: opts.projectRoot,
    autoStructural,
    autoCompliance,
    maxErrorRetries,
    strictDrift: opts.strict,
  };

  const instr = await driveUntilVisible(run, transOpts);
  await writeRunState(opts.projectRoot, run);
  return formatInstruction(attachReport(instr, run));
}

async function driveUntilVisible(
  run: RunState,
  opts: TransitionOpts,
): Promise<Instruction> {
  for (let i = 0; i < 1000; i++) {
    const step = run.steps[run.current_step_index]!;
    const result = await transitionStep(step, { kind: 'enter' }, run, opts);
    step.state = result.next;

    const instr = result.instruction;
    if (instr.kind === 'done') {
      run.status = 'complete';
      return instr;
    }
    if (instr.report_with === '__CONTINUE__') {
      const next = await advanceRun(run);
      if (!next) {
        return {
          kind: 'done',
          body: `Workflow '${run.workflow}' finished.`,
        };
      }
      continue;
    }
    return instr;
  }
  throw new Error(
    'dispatcher looped past 1000 transitions without emitting a visible instruction',
  );
}

function attachReport(instr: Instruction, run: RunState): Instruction {
  if (instr.kind === 'done' || instr.report_with === '__CONTINUE__') {
    return { ...instr, report_with: undefined };
  }
  if (instr.report_with) {
    return instr;
  }
  return {
    ...instr,
    report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index}`,
  };
}

type ParsedStart = { workflow: string; rest: string[] };

function parseStartArgv(raw: string): ParsedStart {
  const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);
  if (tokens.length === 0) {
    throw new Error('ewh start: missing workflow name');
  }
  const [workflow, ...rest] = tokens;
  return { workflow: workflow!, rest };
}

function collectInlineFlags(rest: string[]): Set<string> {
  const flags = new Set<string>();
  for (const t of rest) {
    if (t.startsWith('--')) flags.add(t.slice(2));
  }
  return flags;
}

function stripFlags(rest: string[]): string[] {
  return rest.filter((t) => !t.startsWith('--'));
}

export function isBuiltinSubcommand(name: string): name is BuiltinSubcommand {
  return (BUILTIN_SUBCOMMANDS as readonly string[]).includes(name);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function startSubcommandRun(
  name: BuiltinSubcommand,
  positionalRest: string[],
  opts: StartOptions,
  manageTasks: boolean,
): Promise<string> {
  const run: RunState = {
    run_id: newRunId(),
    workflow: name,
    raw_argv: opts.rawArgv,
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: name,
  };
  await markActive(opts.projectRoot, run.run_id);

  let state: SubcommandState | undefined;
  let instruction: Instruction;
  switch (name) {
    case 'list': {
      instruction = await buildListInstruction({
        projectRoot: opts.projectRoot,
        pluginRoot: opts.pluginRoot,
      });
      state = undefined;
      break;
    }
    case 'cleanup': {
      const r = await startCleanup({
        projectRoot: opts.projectRoot,
        pluginRoot: opts.pluginRoot,
        manageTasks,
      });
      state = r.state;
      instruction = r.instruction;
      break;
    }
    case 'init': {
      const r = await startInit({
        projectRoot: opts.projectRoot,
        pluginRoot: opts.pluginRoot,
      });
      state = r.state;
      instruction = r.instruction;
      break;
    }
    case 'create': {
      const r = await startCreate({
        projectRoot: opts.projectRoot,
        pluginRoot: opts.pluginRoot,
        type: positionalRest[0],
      });
      state = r.state;
      instruction = r.instruction;
      break;
    }
    case 'expand-tools': {
      const r = await startExpandTools({
        projectRoot: opts.projectRoot,
        pluginRoot: opts.pluginRoot,
        description: positionalRest.join(' ').trim() || undefined,
      });
      state = r.state;
      instruction = r.instruction;
      break;
    }
  }

  run.subcommand_state = state;

  if (instruction.kind === 'done') {
    run.status = 'complete';
    await writeRunState(opts.projectRoot, run);
    await clearActive(opts.projectRoot, run.run_id);
    return formatInstruction({ ...instruction, report_with: undefined });
  }

  await writeRunState(opts.projectRoot, run);
  const withReport = instruction.report_with
    ? instruction
    : { ...instruction, report_with: `ewh report --run ${run.run_id} --step 0` };
  return formatInstruction(withReport);
}

/** Entrypoint wired from `src/index.ts`. */
/** Entrypoint wired from `src/index.ts`. */
export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'plugin-root': { type: 'string' },
      'project-root': { type: 'string' },
      'trust': { type: 'boolean' },
      'yolo': { type: 'boolean' },
      'max-retries': { type: 'string' },
      'save': { type: 'boolean' },
      'manage-scripts': { type: 'boolean' },
      'strict': { type: 'boolean' },
      'no-override': { type: 'boolean' },
      'manage-tasks': { type: 'boolean' },
    },
    strict: false,
  });
  const rawArgv = positionals.join(' ');
  const projectRoot =
    (values['project-root'] as string | undefined) ?? process.cwd();
  const pluginRoot =
    (values['plugin-root'] as string | undefined) ??
    process.env.CLAUDE_PLUGIN_ROOT ??
    projectRoot;
  const maxRetriesRaw = values['max-retries'] as string | undefined;
  const maxRetries = maxRetriesRaw !== undefined ? Number.parseInt(maxRetriesRaw, 10) : undefined;
  if (maxRetries !== undefined && Number.isNaN(maxRetries)) {
    throw new Error('--max-retries must be an integer');
  }
  const out = await runStart({
    projectRoot,
    pluginRoot,
    rawArgv,
    trust: values.trust as boolean | undefined,
    yolo: values.yolo as boolean | undefined,
    maxRetries,
    save: values.save as boolean | undefined,
    manageScripts: values['manage-scripts'] as boolean | undefined,
    strict: values['strict'] as boolean | undefined,
    noOverride: values['no-override'] as boolean | undefined,
    manageTasks: values['manage-tasks'] as boolean | undefined,
  });
  process.stdout.write(out);
}
