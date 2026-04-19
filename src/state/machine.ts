/**
 * Pure-ish transition function for step state.
 *
 * Phase 2 makes `transitionStep` async so `agent_run` entry can do I/O
 * (load agent/rules, build prompt). All other transitions remain I/O-free.
 * The exhaustiveness check is preserved — unimplemented phases throw.
 */

import { join, resolve, dirname } from 'node:path';
import { promises as fs } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ContextRef,
  Instruction,
  Report,
  Rule,
  RunState,
  SplitChunk,
  Step,
  StepState,
  StepSummary,
} from './types.js';
import { checkSentinel, SENTINEL } from './sentinel.js';
import { loadAgent } from '../workflow/agent-loader.js';
import { loadRulesForStep } from '../workflow/rule-loader.js';
import { loadHarnessConfig } from '../workflow/harness-config.js';
import {
  buildPrompt,
  extractFilesModified,
  type PriorStepContext,
} from '../workflow/prompt-builder.js';
import { runDir } from './store.js';
import { evaluateScript } from '../scripts/evaluate.js';
import { hashStep } from '../scripts/hash.js';
import {
  writeCachedScript,
  scriptCachePath,
} from '../scripts/cache.js';
import {
  readChunkedPatterns,
  writeChunkedPatterns,
} from './workflow-settings.js';
import {
  DEFAULT_CHUNK_SIZE,
  enumerateFiles,
  parsePatternsContent,
  splitIntoChunks,
} from '../chunking/plan.js';
import {
  INCREMENTAL_ANCHOR,
  mergeChunkArtifacts,
  writeIncrementalAnchor,
} from '../chunking/merge.js';
import { detectListItems } from '../continuation/detect.js';
import {
  buildContinuationPrompt,
  buildSplitChunkPrompt,
} from '../continuation/build-prompt.js';
import { splitItems, DEFAULT_SPLIT_SIZE } from '../continuation/split.js';

const exec = promisify(execCb);

export type TransitionOpts = {
  pluginRoot: string;
  projectRoot: string;
  /** Auto-approve structural gates (--trust or persisted auto_structural). */
  autoStructural?: boolean;
  /** Auto-skip compliance failures (--yolo only; never persisted). */
  autoCompliance?: boolean;
  /** Max agent error retries before gating to user (default 2). */
  maxErrorRetries?: number;
  /** Enable strict drift detection (abort on tool mismatch). */
  strictDrift?: boolean;
};

export type StepEvent =
  | { kind: 'enter' }
  | { kind: 'report'; report: Report };

export type TransitionResult = {
  next: StepState;
  instruction: Instruction;
};

export async function transitionStep(
  step: Step,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const state = step.state;
  switch (state.phase) {
    case 'pending':
      return enterPending(step, event, run, opts);

    case 'gate_pending':
      if (event.kind !== 'report' || event.report.kind !== 'decision') {
        throw new Error(
          `gate_pending expects a decision report; got ${event.kind}`,
        );
      }
      if (event.report.decision === 'yes') {
        if (step.chunked) return enterChunkPlan(step, run, opts);
        if (step.agent) return enterAgentRun(step, run, opts);
        return completeNoop(step, run);
      }
      return {
        next: { phase: 'skipped', reason: 'user declined gate' },
        instruction: doneOrNext(run, step, 'skipped'),
      };

    case 'agent_run':
      return handleAgentRunReport(step, state, event, run, opts);

    case 'compliance':
      return handleComplianceReport(step, state, event, run, opts);

    case 'precondition_failed':
      return {
        next: { phase: 'skipped', reason: state.reason },
        instruction: doneOrNext(run, step, 'skipped'),
      };

    case 'script_eval':
      return enterScriptEvalInline(step, run, opts);

    case 'script_propose':
      return handleScriptProposeReport(step, state, event, run, opts);

    case 'script_run':
      if (event.kind === 'enter') {
        // Crash recovery: re-execute from persisted script_run state.
        return executeScript(step, state, '', run, opts);
      }
      return handleScriptRunReport(step, state, event, run, opts);

    case 'chunk_plan':
      return handleChunkPlanEvent(step, event, run, opts);

    case 'chunk_running':
      return handleChunkRunningEvent(step, state, event, run, opts);

    case 'chunk_merge':
      return enterChunkMerge(step, state, run, opts);

    case 'continuation':
      return handleContinuationEvent(step, state, event, run, opts);

    case 'split':
      return handleSplitEvent(step, state, event, run, opts);

    case 'split_merge':
      return executeSplitMerge(step, state, run, opts);

    case 'artifact_verify':
      return handleArtifactVerifyEvent(step, state, event, run, opts);

    case 'complete':
    case 'skipped':
      throw new Error(`cannot transition terminal phase '${state.phase}'`);

    default: {
      const _exhaustive: never = state;
      throw new Error(`unhandled phase: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function enterPending(
  step: Step,
  _event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const autoStructural = opts.autoStructural ?? false;
  if (step.gate === 'structural' && !autoStructural) {
    const prompt = [
      `Step '${step.name}': structural gate — review before proceeding.`,
      step.description ? `Description: ${step.description}` : '',
      ``,
      `Proceed? Reply:`,
      `  yes:  ewh report --run ${run.run_id} --step ${run.current_step_index} --decision yes`,
      `  no:   ewh report --run ${run.run_id} --step ${run.current_step_index} --decision no`,
    ]
      .filter((l) => l !== undefined)
      .join('\n');
    return {
      next: { phase: 'gate_pending', prompt },
      instruction: {
        kind: 'user-prompt',
        body: prompt,
        report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index} --decision yes`,
      },
    };
  }
  if (step.chunked) return enterChunkPlan(step, run, opts);
  return enterScriptEvalInline(step, run, opts);
}

/** Shared logic for `pending` and `script_eval` (crash-recovery). */
async function enterScriptEvalInline(
  step: Step,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (step.agent || step.script) {
    const decision = await evaluateScript(opts.projectRoot, run.workflow, step);
    switch (decision.kind) {
      case 'explicit':
      case 'cached': {
        const staleNote =
          decision.kind === 'cached' && decision.stale
            ? `\u26a0 Cached script may be stale (step definition has changed since last approval).`
            : '';
        const scriptRunState: Extract<StepState, { phase: 'script_run' }> = {
          phase: 'script_run',
          script_path: decision.scriptPath,
          attempts: 0,
        };
        return executeScript(step, scriptRunState, staleNote, run, opts);
      }
      case 'propose':
        return enterScriptPropose(step, run, opts);
      case 'agent':
        break;
    }
  }
  if (step.agent) return enterAgentRun(step, run, opts);
  return completeNoop(step, run);
}

function generateScriptTemplate(step: Step, workflow: string): string {
  const lines = [
    '#!/usr/bin/env bash',
    `# Step: ${step.name} (workflow: ${workflow})`,
  ];
  if (step.description) lines.push(`# ${step.description}`);
  lines.push('set -euo pipefail', '', '# TODO: implement this step', 'echo "Step completed."');
  return lines.join('\n') + '\n';
}

function enterScriptPropose(
  step: Step,
  run: RunState,
  opts: TransitionOpts,
): TransitionResult {
  const template = generateScriptTemplate(step, run.workflow);
  const rationale = `Step has an agent but no reads/artifact/context — eligible for scripting.`;
  const proposedPath = join(
    runDir(opts.projectRoot, run.run_id),
    `step-${run.current_step_index}-script-proposal.sh`,
  );
  const next: StepState = {
    phase: 'script_propose',
    script: template,
    rationale,
    proposed_path: proposedPath,
  };
  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  return {
    next,
    instruction: {
      kind: 'user-prompt',
      body: [
        `Step '${step.name}' could be automated with a Bash script.`,
        step.description ? `Description: ${step.description}` : '',
        ``,
        `Proposed script:`,
        `\`\`\`bash`,
        template.trimEnd(),
        `\`\`\``,
        ``,
        `To approve as-is:`,
        `  ewh report --run ${runId} --step ${stepIdx} --decision yes`,
        `To customise: write your script to ${proposedPath}, then approve.`,
        `To skip scripting (use agent instead):`,
        `  ewh report --run ${runId} --step ${stepIdx} --decision no`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
      report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
    },
  };
}

async function handleScriptProposeReport(
  step: Step,
  state: Extract<StepState, { phase: 'script_propose' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind !== 'report' || event.report.kind !== 'decision') {
    throw new Error(`script_propose expects a decision report; got ${event.kind}`);
  }

  if (event.report.decision === 'no') {
    if (step.agent) return enterAgentRun(step, run, opts);
    return {
      next: { phase: 'skipped', reason: 'script proposal declined, no agent fallback' },
      instruction: doneOrNext(run, step, 'skipped'),
    };
  }

  // yes — check if LLM wrote a custom script to proposed_path; fall back to template.
  let scriptBody = state.script;
  try {
    scriptBody = await fs.readFile(state.proposed_path, 'utf8');
  } catch {
    // proposed_path not written — use template
  }

  const hash = hashStep(step);
  await writeCachedScript(opts.projectRoot, run.workflow, step.name, scriptBody, hash);

  const cachePath = scriptCachePath(opts.projectRoot, run.workflow, step.name);
  const scriptRunState: Extract<StepState, { phase: 'script_run' }> = {
    phase: 'script_run',
    script_path: cachePath,
    attempts: 0,
  };
  return executeScript(step, scriptRunState, '', run, opts);
}

async function executeScript(
  step: Step,
  state: Extract<StepState, { phase: 'script_run' }>,
  staleNote: string,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  try {
    const { stdout } = await exec(`bash "${state.script_path}"`, {
      cwd: opts.projectRoot,
    });
    const noteParts = [staleNote, stdout.trim()].filter(Boolean);
    const summary: StepSummary = {
      step_name: step.name,
      outcome: 'completed',
      notes: noteParts.length > 0 ? noteParts.join('\n') : undefined,
    };
    return {
      next: { phase: 'complete', summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [`${e.stdout ?? ''}`, `${e.stderr ?? ''}`].join('').trim();
    const newState: Extract<StepState, { phase: 'script_run' }> = {
      ...state,
      attempts: state.attempts + 1,
    };

    const fallback = step.script_fallback ?? 'gate';
    if (fallback === 'auto' && step.agent) {
      return enterAgentRun(step, run, opts);
    }

    return scriptFailGate(step, newState, output, staleNote, run);
  }
}

function scriptFailGate(
  step: Step,
  state: Extract<StepState, { phase: 'script_run' }>,
  errorOutput: string,
  staleNote: string,
  run: RunState,
): TransitionResult {
  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  const lines = [
    `Step '${step.name}': script failed (attempt ${state.attempts}).`,
  ];
  if (staleNote) lines.push(staleNote);
  lines.push(
    `Script: ${state.script_path}`,
    ``,
    `Error output:`,
    `  ${errorOutput || '(none)'}`,
    ``,
    `Options:`,
    `  retry:   ewh report --run ${runId} --step ${stepIdx} --decision yes`,
    step.agent
      ? `  use agent instead:  ewh report --run ${runId} --step ${stepIdx} --decision no`
      : `  skip this step:     ewh report --run ${runId} --step ${stepIdx} --decision no`,
    `  abort:   ewh report --run ${runId} --abort`,
  );
  return {
    next: state,
    instruction: {
      kind: 'user-prompt',
      body: lines.join('\n'),
      report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
    },
  };
}

async function handleScriptRunReport(
  step: Step,
  state: Extract<StepState, { phase: 'script_run' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind !== 'report' || event.report.kind !== 'decision') {
    throw new Error(
      `script_run expects a decision report; got ${event.kind}`,
    );
  }

  if (event.report.decision === 'yes') {
    return executeScript(step, state, '', run, opts);
  }

  // no → agent fallback or skip
  if (step.agent) return enterAgentRun(step, run, opts);
  return {
    next: { phase: 'skipped', reason: 'script failed, no agent fallback' },
    instruction: doneOrNext(run, step, 'skipped'),
  };
}

async function enterAgentRun(
  step: Step,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const { pluginRoot, projectRoot } = opts;
  const rdPath = runDir(projectRoot, run.run_id);
  const stepIndex = run.current_step_index;

  const [agent, loadedRules, harnessConfig] = await Promise.all([
    loadAgent(step.agent!, pluginRoot, projectRoot),
    loadRulesForStep(step.rules ?? [], pluginRoot, projectRoot),
    loadHarnessConfig(projectRoot),
  ]);

  const priorSteps = collectPriorSteps(step.context ?? [], run);

  const { promptPath, resultPath } = await buildPrompt({
    step,
    agent,
    rules: loadedRules,
    run,
    priorSteps,
    harnessConfig,
    runDirPath: rdPath,
    stepIndex,
    projectRoot,
  });

  // Convert to lightweight Rule for state (no body stored in state JSON).
  const rules: Rule[] = loadedRules.map((r) => ({
    name: r.name,
    path: r.path,
    severity: r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'info',
    verify: r.verify ?? undefined,
  }));

  const next: StepState = {
    phase: 'agent_run',
    prompt_path: promptPath,
    result_path: resultPath,
    retries: 0,
    rules,
  };

  const tools = agent.tools ? agent.tools.join(', ') : 'default';
  const instruction: Instruction = {
    kind: 'tool-call',
    body: buildAgentCallBody(step, { prompt_path: promptPath, result_path: resultPath }, run, {
      model: agent.model,
      maxTurns: agent.maxTurns,
      tools,
    }),
    report_with: `ewh report --run ${run.run_id} --step ${stepIndex} --result ${resultPath}`,
  };

  return { next, instruction };
}

async function handleAgentRunReport(
  step: Step,
  state: Extract<StepState, { phase: 'agent_run' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind !== 'report') {
    throw new Error(`agent_run expects a report event; got ${event.kind}`);
  }

  const maxRetries = opts.maxErrorRetries ?? 2;
  const runId = run.run_id;
  const stepIdx = run.current_step_index;

  // Error report: increment retries, retry or gate on exhaustion.
  if (event.report.kind === 'error') {
    const newRetries = state.retries + 1;
    const nextState: StepState = { ...state, retries: newRetries };
    if (newRetries <= maxRetries) {
      return {
        next: nextState,
        instruction: {
          kind: 'tool-call',
          body: [
            `Step '${step.name}': agent error (attempt ${newRetries + 1}/${maxRetries + 1}).`,
            `Error: ${event.report.message}`,
            ``,
            `Retrying with the same prompt...`,
            ``,
            buildAgentCallBody(step, state, run, {}),
          ].join('\n'),
          report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${state.result_path}`,
        },
      };
    }
    // Exhausted: gate to user.
    return {
      next: nextState,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': agent failed after ${newRetries} attempts.`,
          `Last error: ${event.report.message}`,
          ``,
          `Options:`,
          `  retry:  ewh report --run ${runId} --step ${stepIdx} --decision yes`,
          `  skip:   ewh report --run ${runId} --step ${stepIdx} --decision no`,
          `  abort:  ewh report --run ${runId} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
      },
    };
  }

  // Decision report: user responded to the exhaustion gate.
  if (event.report.kind === 'decision') {
    if (event.report.decision === 'no') {
      return {
        next: { phase: 'skipped', reason: 'user skipped after error exhaustion' },
        instruction: doneOrNext(run, step, 'skipped'),
      };
    }
    // yes → reset retries and retry.
    const resetState: StepState = { ...state, retries: 0 };
    return {
      next: resetState,
      instruction: {
        kind: 'tool-call',
        body: buildAgentCallBody(step, state, run, {}),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${state.result_path}`,
      },
    };
  }

  if (event.report.kind !== 'result') {
    throw new Error(`agent_run: unexpected report kind '${event.report.kind}'`);
  }

  const resultPath = event.report.result_path ?? state.result_path;

  let content: string;
  try {
    content = await fs.readFile(resultPath, 'utf8');
  } catch (err) {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: `Step '${step.name}': cannot read result file '${resultPath}'.\nError: ${err instanceof Error ? err.message : String(err)}\nFix the path and re-report or abort.`,
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
      },
    };
  }

  if (!checkSentinel(content)) {
    return enterContinuation(step, state, resultPath, content, run, opts);
  }

  const filesModified = extractFilesModified(content);
  const summary: StepSummary = {
    step_name: step.name,
    outcome: 'completed',
    files_modified: filesModified,
    result_path: resultPath,
  };

  return enterArtifactVerify(step, state.rules, summary, run, opts);
}

async function runComplianceCheck(
  step: Step,
  rules: Rule[],
  summary: StepSummary,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const criticalRules = rules.filter((r) => r.severity === 'critical' && r.verify);
  if (criticalRules.length === 0) {
    return {
      next: { phase: 'complete', summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  }

  const failures = await runVerifyCommands(criticalRules, opts.projectRoot);
  if (failures.length === 0) {
    return {
      next: { phase: 'complete', summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  }

  if (opts.autoCompliance) {
    process.stderr.write(
      `\n[EWH YOLO] Compliance check FAILED for step '${step.name}' — auto-skipping (--yolo):\n` +
        failures.map((f) => `  [${f.rule}] ${f.output}`).join('\n') +
        '\n',
    );
    return {
      next: { phase: 'complete', summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  }

  return {
    next: { phase: 'compliance', critical_rules: criticalRules, summary },
    instruction: complianceFailInstruction(step, failures, run),
  };
}

async function handleComplianceReport(
  step: Step,
  state: Extract<StepState, { phase: 'compliance' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind !== 'report' || event.report.kind !== 'decision') {
    throw new Error(`compliance expects a decision report; got ${event.kind}`);
  }

  if (event.report.decision === 'no') {
    const summary: StepSummary = {
      ...state.summary,
      notes: 'compliance check skipped by user',
    };
    return {
      next: { phase: 'complete', summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  }

  // yes → re-run verify commands.
  const failures = await runVerifyCommands(state.critical_rules, opts.projectRoot);
  if (failures.length === 0) {
    return {
      next: { phase: 'complete', summary: state.summary },
      instruction: doneOrNext(run, step, 'completed'),
    };
  }

  return {
    next: state,
    instruction: complianceFailInstruction(step, failures, run),
  };
}

async function runVerifyCommands(
  rules: Rule[],
  cwd: string,
): Promise<{ rule: string; output: string }[]> {
  const failures: { rule: string; output: string }[] = [];
  for (const rule of rules) {
    if (!rule.verify) continue;
    try {
      await exec(rule.verify, { cwd });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = [`${e.stdout ?? ''}`, `${e.stderr ?? ''}`].join('').trim();
      failures.push({ rule: rule.name, output: out || (e.message ?? 'unknown error') });
    }
  }
  return failures;
}

function complianceFailInstruction(
  step: Step,
  failures: { rule: string; output: string }[],
  run: RunState,
): Instruction {
  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  const failureText = failures.map((f) => `  [${f.rule}]:\n    ${f.output}`).join('\n');
  return {
    kind: 'user-prompt',
    body: [
      `Step '${step.name}': compliance check FAILED.`,
      ``,
      `Failing rules:`,
      failureText,
      ``,
      `Fix the issues and then:`,
      `  retry check:  ewh report --run ${runId} --step ${stepIdx} --decision yes`,
      `  skip check:   ewh report --run ${runId} --step ${stepIdx} --decision no`,
      `  abort:        ewh report --run ${runId} --abort`,
    ].join('\n'),
    report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
  };
}

function buildAgentCallBody(
  step: Step,
  state: { prompt_path: string; result_path: string },
  run: RunState,
  meta: { model?: string; maxTurns?: number; tools?: string },
): string {
  const lines = [
    `Tool: Agent`,
    `Args:`,
    `  subagent_type: ewh:${step.agent}`,
    `  prompt: |`,
    `    Read ${state.prompt_path} and follow it exactly.`,
    `  description: "${run.workflow}: ${step.name}"`,
  ];
  if (meta.model || meta.maxTurns || meta.tools) {
    lines.push(``);
    lines.push(
      `Agent config — model: ${meta.model ?? 'default'}, maxTurns: ${meta.maxTurns ?? 'default'}, tools: ${meta.tools ?? 'default'}`,
    );
  }
  lines.push(``, `After the Agent tool returns, save its final output to:`, `  ${state.result_path}`, `Then report back.`);
  return lines.join('\n');
}

function collectPriorSteps(
  refs: ContextRef[],
  run: RunState,
): PriorStepContext[] {
  return refs.flatMap((ref) => {
    const priorStep = run.steps.find((s) => s.name === ref.step);
    if (!priorStep || priorStep.state.phase !== 'complete') return [];
    return [{ ref, summary: priorStep.state.summary }];
  });
}

async function enterChunkPlan(
  step: Step,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (!step.agent) {
    throw new Error(
      `chunked step '${step.name}' requires an agent to dispatch per-chunk work`,
    );
  }
  const cached = await readChunkedPatterns(opts.projectRoot, run.workflow, step.name);
  if (cached) {
    return beginChunkRunning(step, cached, run, opts);
  }

  const rdPath = runDir(opts.projectRoot, run.run_id);
  const patternsPath = join(
    rdPath,
    `step-${run.current_step_index}-chunk-patterns.json`,
  );
  await fs.mkdir(rdPath, { recursive: true });
  try {
    await fs.access(patternsPath);
  } catch {
    const example = {
      include: ['src/**/*.ts'],
      exclude: ['**/node_modules/**'],
    };
    await fs.writeFile(patternsPath, JSON.stringify(example, null, 2) + '\n', 'utf8');
  }

  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  const body = [
    `Step '${step.name}': chunked dispatch — glob patterns needed.`,
    step.description ? `Description: ${step.description}` : '',
    ``,
    `Edit ${patternsPath} with include/exclude globs, then approve.`,
    `Format: JSON object { "include": [...], "exclude": [...] } or a bare array of globs.`,
    ``,
    `Options:`,
    `  approve:  ewh report --run ${runId} --step ${stepIdx} --result ${patternsPath}`,
    `  abort:    ewh report --run ${runId} --abort`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    next: { phase: 'chunk_plan' },
    instruction: {
      kind: 'user-prompt',
      body,
      report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${patternsPath}`,
    },
  };
}

async function handleChunkPlanEvent(
  step: Step,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind === 'enter') {
    return enterChunkPlan(step, run, opts);
  }
  if (event.report.kind !== 'result') {
    throw new Error(`chunk_plan expects a --result report; got ${event.report.kind}`);
  }
  const patternsPath = event.report.result_path;
  if (!patternsPath) {
    return {
      next: { phase: 'chunk_plan' },
      instruction: {
        kind: 'user-prompt',
        body: `chunk_plan: --result <path> is required (point at the patterns JSON).`,
        report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index} --result <path>`,
      },
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(patternsPath, 'utf8');
  } catch (err) {
    return {
      next: { phase: 'chunk_plan' },
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': cannot read patterns file '${patternsPath}'.`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Create the file and re-report, or abort.`,
        ].join('\n'),
        report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index} --result ${patternsPath}`,
      },
    };
  }

  let patterns;
  try {
    patterns = parsePatternsContent(raw);
  } catch (err) {
    return {
      next: { phase: 'chunk_plan' },
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': invalid patterns.`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Fix ${patternsPath} and re-report.`,
        ].join('\n'),
        report_with: `ewh report --run ${run.run_id} --step ${run.current_step_index} --result ${patternsPath}`,
      },
    };
  }

  await writeChunkedPatterns(opts.projectRoot, run.workflow, step.name, patterns);
  return beginChunkRunning(step, patterns, run, opts);
}

async function beginChunkRunning(
  step: Step,
  patterns: { include: string[]; exclude?: string[] },
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const files = await enumerateFiles(patterns, opts.projectRoot);
  if (files.length === 0) {
    const summary: StepSummary = {
      step_name: step.name,
      outcome: 'skipped',
      notes: 'chunked: no files matched include/exclude patterns',
    };
    return {
      next: { phase: 'skipped', reason: summary.notes! },
      instruction: doneOrNext(run, step, 'skipped'),
    };
  }
  const chunks = splitIntoChunks(files, DEFAULT_CHUNK_SIZE);

  // If it's a single chunk, we could still use the regular agent path, but
  // the chunked flow is the explicit contract for `chunked: true`, so keep
  // the chunked pipeline even for N=1.
  const rdPath = runDir(opts.projectRoot, run.run_id);
  const stepIdx = run.current_step_index;
  const chunk_prompt_paths = chunks.map((_c, i) =>
    join(rdPath, `step-${stepIdx}-chunk-${i + 1}-prompt.md`),
  );
  const chunk_result_paths = chunks.map((_c, i) =>
    join(rdPath, `step-${stepIdx}-chunk-${i + 1}-output.md`),
  );
  const chunk_artifact_paths = chunks.map((_c, i) =>
    join(rdPath, `step-${stepIdx}-chunk-${i + 1}-artifact.md`),
  );

  const { agent, loadedRules } = await loadAgentAndRules(step, run, opts);

  const rules: Rule[] = loadedRules.map((r) => ({
    name: r.name,
    path: r.path,
    severity:
      r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'info',
    verify: r.verify ?? undefined,
  }));

  const completed = new Array<boolean>(chunks.length).fill(false);
  const retries = new Array<number>(chunks.length).fill(0);
  const incremental = !!agent.incremental;

  if (incremental) {
    const header = step.artifact
      ? `# ${step.artifact} — chunk findings`
      : `# ${step.name} — chunk findings`;
    await Promise.all(
      chunk_artifact_paths.map((p) => writeIncrementalAnchor(p, header)),
    );
  }

  const running: Extract<StepState, { phase: 'chunk_running' }> = {
    phase: 'chunk_running',
    chunks,
    chunk_index: 0,
    total: chunks.length,
    completed,
    chunk_prompt_paths,
    chunk_result_paths,
    chunk_artifact_paths,
    retries,
    rules,
    incremental,
  };

  const instruction = await buildChunkInstruction(step, running, 0, run, opts);
  return { next: running, instruction };
}

async function handleChunkRunningEvent(
  step: Step,
  state: Extract<StepState, { phase: 'chunk_running' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind === 'enter') {
    // Crash recovery: re-emit instruction for the current chunk_index.
    const instruction = await buildChunkInstruction(
      step,
      state,
      state.chunk_index,
      run,
      opts,
    );
    return { next: state, instruction };
  }

  const idx = state.chunk_index;
  const runId = run.run_id;
  const stepIdx = run.current_step_index;

  if (event.report.kind === 'error') {
    // Per spec: incremental agents gate directly on per-chunk failure
    // (no continuation/split). Non-incremental also gate — continuation
    // and split are Phase 6. Retry up to maxErrorRetries before gating.
    const maxRetries = opts.maxErrorRetries ?? 2;
    const newRetries = [...state.retries];
    newRetries[idx] = (state.retries[idx] ?? 0) + 1;
    const nextState: StepState = { ...state, retries: newRetries };
    if ((newRetries[idx] ?? 0) <= maxRetries) {
      const instruction = await buildChunkInstruction(step, state, idx, run, opts, {
        retryNote: `chunk ${idx + 1}/${state.total}: agent error — retry ${newRetries[idx]}/${maxRetries + 1}. ${event.report.message}`,
      });
      return { next: nextState, instruction };
    }
    return {
      next: nextState,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': chunk ${idx + 1}/${state.total} failed after ${newRetries[idx]} attempts.`,
          `Error: ${event.report.message}`,
          state.incremental
            ? `Incremental agent: retry resumes from the on-disk artifact.`
            : `Non-incremental: retry re-runs the chunk from scratch.`,
          ``,
          `Options:`,
          `  retry:  ewh report --run ${runId} --step ${stepIdx} --decision yes`,
          `  skip chunk:  ewh report --run ${runId} --step ${stepIdx} --decision no`,
          `  abort:  ewh report --run ${runId} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
      },
    };
  }

  if (event.report.kind === 'decision') {
    if (event.report.decision === 'no') {
      // skip this chunk → mark completed (missing artifact will show up in merge)
      return advanceChunkOrMerge(step, state, run, opts);
    }
    // yes: retry current chunk
    const resetRetries = [...state.retries];
    resetRetries[idx] = 0;
    const nextState: Extract<StepState, { phase: 'chunk_running' }> = {
      ...state,
      retries: resetRetries,
    };
    const instruction = await buildChunkInstruction(step, nextState, idx, run, opts);
    return { next: nextState, instruction };
  }

  if (event.report.kind !== 'result') {
    throw new Error(`chunk_running: unexpected report kind '${event.report.kind}'`);
  }

  // result report: verify sentinel, then advance.
  const resultPath = event.report.result_path ?? state.chunk_result_paths[idx]!;
  let content: string;
  try {
    content = await fs.readFile(resultPath, 'utf8');
  } catch (err) {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}' chunk ${idx + 1}: cannot read result '${resultPath}'.`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Fix the path and re-report, or abort.`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
      },
    };
  }

  if (!checkSentinel(content)) {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}' chunk ${idx + 1}: output missing AGENT_COMPLETE sentinel.`,
          `Result file: ${resultPath}`,
          ``,
          `Re-run the worker and report a corrected path, or abort.`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
      },
    };
  }

  return advanceChunkOrMerge(step, state, run, opts);
}

async function advanceChunkOrMerge(
  step: Step,
  state: Extract<StepState, { phase: 'chunk_running' }>,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const idx = state.chunk_index;
  const nextCompleted = [...state.completed];
  nextCompleted[idx] = true;
  const nextIdx = idx + 1;

  if (nextIdx >= state.total) {
    const mergeState: Extract<StepState, { phase: 'chunk_merge' }> = {
      phase: 'chunk_merge',
      chunk_artifact_paths: state.chunk_artifact_paths,
      rules: state.rules,
      incremental: state.incremental,
    };
    return enterChunkMerge(step, mergeState, run, opts);
  }

  const advanced: Extract<StepState, { phase: 'chunk_running' }> = {
    ...state,
    completed: nextCompleted,
    chunk_index: nextIdx,
  };
  const instruction = await buildChunkInstruction(step, advanced, nextIdx, run, opts);
  return { next: advanced, instruction };
}

async function enterChunkMerge(
  step: Step,
  state: Extract<StepState, { phase: 'chunk_merge' }>,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  let mergeNote: string;
  if (step.artifact) {
    const result = await mergeChunkArtifacts({
      chunkArtifactPaths: state.chunk_artifact_paths,
      targetArtifact: step.artifact,
      projectRoot: opts.projectRoot,
      incremental: state.incremental,
    });
    mergeNote = `chunks merged → ${step.artifact} (${result.present} present, ${result.missing} missing)`;
  } else {
    mergeNote = `chunks completed (${state.chunk_artifact_paths.length} total; no artifact declared — nothing to merge)`;
  }

  const summary: StepSummary = {
    step_name: step.name,
    outcome: 'completed',
    notes: mergeNote,
  };
  return runComplianceCheck(step, state.rules, summary, run, opts);
}

async function loadAgentAndRules(
  step: Step,
  run: RunState,
  opts: TransitionOpts,
): Promise<{
  agent: Awaited<ReturnType<typeof loadAgent>>;
  loadedRules: Awaited<ReturnType<typeof loadRulesForStep>>;
}> {
  const [agent, loadedRules] = await Promise.all([
    loadAgent(step.agent!, opts.pluginRoot, opts.projectRoot),
    loadRulesForStep(step.rules ?? [], opts.pluginRoot, opts.projectRoot),
  ]);
  return { agent, loadedRules };
}

async function buildChunkInstruction(
  step: Step,
  state: Extract<StepState, { phase: 'chunk_running' }>,
  idx: number,
  run: RunState,
  opts: TransitionOpts,
  extra?: { retryNote?: string },
): Promise<Instruction> {
  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  const promptPath = state.chunk_prompt_paths[idx]!;
  const resultPath = state.chunk_result_paths[idx]!;
  const artifactPath = state.chunk_artifact_paths[idx]!;
  const files = state.chunks[idx]!;

  const { agent, loadedRules } = await loadAgentAndRules(step, run, opts);
  const harnessConfig = await loadHarnessConfig(opts.projectRoot);

  const priorSteps = collectPriorSteps(step.context ?? [], run);
  const rdPath = runDir(opts.projectRoot, run.run_id);

  const chunkStep: Step = {
    ...step,
    description: buildChunkDescription(step, idx, state.total, files, artifactPath, state.incremental),
    // Override artifact so buildPrompt emits the per-chunk artifact path.
    artifact: artifactPath,
    reads: step.reads,
  };

  await buildPrompt({
    step: chunkStep,
    agent,
    rules: loadedRules,
    run,
    priorSteps,
    harnessConfig,
    runDirPath: rdPath,
    stepIndex: stepIdx,
    projectRoot: opts.projectRoot,
    // The default naming in buildPrompt is step-N-prompt.md; we route into
    // per-chunk paths manually below by writing to the desired path after.
  } as Parameters<typeof buildPrompt>[0]);

  // buildPrompt writes to step-{stepIndex}-prompt.md; mirror that file into
  // the per-chunk prompt path so the emitted tool-call points at the right
  // file. This avoids extending buildPrompt's signature.
  const defaultPromptPath = join(rdPath, `step-${stepIdx}-prompt.md`);
  try {
    const body = await fs.readFile(defaultPromptPath, 'utf8');
    await fs.writeFile(promptPath, body, 'utf8');
  } catch {
    // buildPrompt should have created it; swallow on failure so the
    // subsequent tool-call surfaces a clearer error to the user.
  }

  const toolsList = agent.tools ? agent.tools.join(', ') : 'default';
  const lines = [
    extra?.retryNote ? `[retry] ${extra.retryNote}` : '',
    `Tool: Agent`,
    `Args:`,
    `  subagent_type: ewh:${step.agent}`,
    `  prompt: |`,
    `    Read ${promptPath} and follow it exactly.`,
    `  description: "${run.workflow}: ${step.name} (chunk ${idx + 1}/${state.total})"`,
    ``,
    `Agent config — model: ${agent.model ?? 'default'}, maxTurns: ${agent.maxTurns ?? 'default'}, tools: ${toolsList}`,
    ``,
    `After the Agent tool returns, save its final output to:`,
    `  ${resultPath}`,
    `Then report back.`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    kind: 'tool-call',
    body: lines,
    report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
  };
}

function buildChunkDescription(
  step: Step,
  idx: number,
  total: number,
  files: string[],
  artifactPath: string,
  incremental: boolean,
): string {
  const lines = [
    step.description ?? step.name,
    ``,
    `This invocation handles chunk ${idx + 1} of ${total} for step '${step.name}'.`,
    `Files in this chunk (${files.length}):`,
    ...files.map((f) => `  - ${f}`),
    ``,
  ];
  if (incremental) {
    lines.push(
      `This is an incremental agent — the artifact '${artifactPath}' has been pre-created`,
      `with an append anchor (${INCREMENTAL_ANCHOR}).`,
      `For each finding, use the Edit tool to insert content BEFORE the anchor line.`,
      `Do NOT rewrite the file wholesale.`,
    );
  } else {
    lines.push(
      `Write your findings for this chunk to '${artifactPath}'.`,
      `(The dispatcher will concatenate chunk artifacts into '${step.artifact ?? '<none>'}' after all chunks complete.)`,
    );
  }
  return lines.join('\n');
}

// ── Phase 6: continuation ──────────────────────────────────────────────────

async function enterContinuation(
  step: Step,
  agentRunState: Extract<StepState, { phase: 'agent_run' }>,
  partialPath: string,
  partialOutput: string,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const rdPath = runDir(opts.projectRoot, run.run_id);
  const stepIdx = run.current_step_index;
  await fs.mkdir(rdPath, { recursive: true });

  const continuationPromptPath = join(rdPath, `step-${stepIdx}-continuation-prompt.md`);
  const continuationResultPath = join(rdPath, `step-${stepIdx}-continuation-output.md`);

  const promptContent = await buildContinuationPrompt({
    originalPromptPath: agentRunState.prompt_path,
    partialOutput,
  });
  await fs.writeFile(continuationPromptPath, promptContent, 'utf8');

  const next: StepState = {
    phase: 'continuation',
    partial_path: partialPath,
    original_prompt_path: agentRunState.prompt_path,
    continuation_prompt_path: continuationPromptPath,
    continuation_result_path: continuationResultPath,
    rules: agentRunState.rules,
  };

  const agent = await loadAgent(step.agent!, opts.pluginRoot, opts.projectRoot);
  return {
    next,
    instruction: buildContinuationAgentCall(step, continuationPromptPath, continuationResultPath, agent, run),
  };
}

function buildContinuationAgentCall(
  step: Step,
  promptPath: string,
  resultPath: string,
  agent: Awaited<ReturnType<typeof loadAgent>>,
  run: RunState,
): Instruction {
  const tools = agent.tools ? agent.tools.join(', ') : 'default';
  const runId = run.run_id;
  const stepIdx = run.current_step_index;
  return {
    kind: 'tool-call',
    body: [
      `Step '${step.name}': sentinel missing — running continuation agent.`,
      ``,
      `Tool: Agent`,
      `Args:`,
      `  subagent_type: ewh:${step.agent}`,
      `  prompt: |`,
      `    Read ${promptPath} and follow it exactly.`,
      `  description: "${run.workflow}: ${step.name} (continuation)"`,
      ``,
      `Agent config — model: ${agent.model ?? 'default'}, maxTurns: ${agent.maxTurns ?? 'default'}, tools: ${tools}`,
      ``,
      `After the Agent tool returns, save its final output to:`,
      `  ${resultPath}`,
      `Then report back.`,
    ].join('\n'),
    report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
  };
}

async function handleContinuationEvent(
  step: Step,
  state: Extract<StepState, { phase: 'continuation' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind === 'enter') {
    // Crash recovery: re-emit the continuation tool-call.
    const agent = await loadAgent(step.agent!, opts.pluginRoot, opts.projectRoot);
    return {
      next: state,
      instruction: buildContinuationAgentCall(
        step,
        state.continuation_prompt_path,
        state.continuation_result_path,
        agent,
        run,
      ),
    };
  }

  if (event.report.kind === 'error') {
    // Continuation agent crashed → escalate to split.
    return enterSplit(step, state, run, opts);
  }

  if (event.report.kind !== 'result') {
    throw new Error(`continuation: unexpected report kind '${event.report.kind}'`);
  }

  const resultPath = event.report.result_path ?? state.continuation_result_path;
  let content: string;
  try {
    content = await fs.readFile(resultPath, 'utf8');
  } catch {
    // Can't read → escalate to split.
    return enterSplit(step, state, run, opts);
  }

  if (!checkSentinel(content)) {
    // Still no sentinel → escalate to split.
    return enterSplit(step, state, run, opts);
  }

  const summary: StepSummary = {
    step_name: step.name,
    outcome: 'completed',
    files_modified: extractFilesModified(content),
    result_path: resultPath,
  };
  return enterArtifactVerify(step, state.rules, summary, run, opts);
}

// ── Phase 6: split ─────────────────────────────────────────────────────────

async function enterSplit(
  step: Step,
  contState: Extract<StepState, { phase: 'continuation' }>,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const rdPath = runDir(opts.projectRoot, run.run_id);
  const stepIdx = run.current_step_index;
  await fs.mkdir(rdPath, { recursive: true });

  // Detect list items from the partial output.
  let partial = '';
  try {
    partial = await fs.readFile(contState.partial_path, 'utf8');
  } catch {
    // Unreadable partial → zero items detected; falls back to full-task re-run.
  }
  const items = detectListItems(partial);

  // When no items detected, produce a single chunk that re-runs the full task.
  const itemGroups = items.length > 0 ? splitItems(items, DEFAULT_SPLIT_SIZE) : [[] as string[]];

  const chunks: SplitChunk[] = itemGroups.map((chunkItems, i) => ({
    index: i,
    items: chunkItems,
    prompt_path: join(rdPath, `step-${stepIdx}-split-${i + 1}-prompt.md`),
    result_path: join(rdPath, `step-${stepIdx}-split-${i + 1}-output.md`),
  }));

  // Write all chunk prompts to disk up-front.
  await Promise.all(
    chunks.map((chunk) =>
      buildSplitChunkPrompt({
        originalPromptPath: contState.original_prompt_path,
        items: chunk.items,
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
      }).then((content) => fs.writeFile(chunk.prompt_path, content, 'utf8')),
    ),
  );

  const next: StepState = {
    phase: 'split',
    chunks,
    completed: new Array<boolean>(chunks.length).fill(false),
    current_chunk_index: 0,
    rules: contState.rules,
  };

  const instruction = await buildSplitInstruction(
    step,
    next as Extract<StepState, { phase: 'split' }>,
    0,
    run,
    opts,
  );
  return { next, instruction };
}

async function buildSplitInstruction(
  step: Step,
  state: Extract<StepState, { phase: 'split' }>,
  idx: number,
  run: RunState,
  opts: TransitionOpts,
): Promise<Instruction> {
  const chunk = state.chunks[idx]!;
  const agent = await loadAgent(step.agent!, opts.pluginRoot, opts.projectRoot);
  const tools = agent.tools ? agent.tools.join(', ') : 'default';
  const runId = run.run_id;
  const stepIdx = run.current_step_index;

  return {
    kind: 'tool-call',
    body: [
      `Tool: Agent`,
      `Args:`,
      `  subagent_type: ewh:${step.agent}`,
      `  prompt: |`,
      `    Read ${chunk.prompt_path} and follow it exactly.`,
      `  description: "${run.workflow}: ${step.name} (split ${idx + 1}/${state.chunks.length})"`,
      ``,
      `Agent config — model: ${agent.model ?? 'default'}, maxTurns: ${agent.maxTurns ?? 'default'}, tools: ${tools}`,
      ``,
      `After the Agent tool returns, save its final output to:`,
      `  ${chunk.result_path}`,
      `Then report back.`,
    ].join('\n'),
    report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${chunk.result_path}`,
  };
}

async function handleSplitEvent(
  step: Step,
  state: Extract<StepState, { phase: 'split' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind === 'enter') {
    // Crash recovery: re-emit instruction for current chunk.
    const instruction = await buildSplitInstruction(step, state, state.current_chunk_index, run, opts);
    return { next: state, instruction };
  }

  const idx = state.current_chunk_index;
  const runId = run.run_id;
  const stepIdx = run.current_step_index;

  if (event.report.kind === 'error') {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': split chunk ${idx + 1}/${state.chunks.length} failed.`,
          `Error: ${event.report.message}`,
          ``,
          `Options:`,
          `  retry:       ewh report --run ${runId} --step ${stepIdx} --decision yes`,
          `  skip chunk:  ewh report --run ${runId} --step ${stepIdx} --decision no`,
          `  abort:       ewh report --run ${runId} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
      },
    };
  }

  if (event.report.kind === 'decision') {
    if (event.report.decision === 'no') {
      return advanceSplitOrMerge(step, state, run, opts);
    }
    // yes → retry current chunk.
    const instruction = await buildSplitInstruction(step, state, idx, run, opts);
    return { next: state, instruction };
  }

  if (event.report.kind !== 'result') {
    throw new Error(`split: unexpected report kind '${event.report.kind}'`);
  }

  const chunk = state.chunks[idx]!;
  const resultPath = event.report.result_path ?? chunk.result_path;

  let content: string;
  try {
    content = await fs.readFile(resultPath, 'utf8');
  } catch (err) {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}' split chunk ${idx + 1}: cannot read result '${resultPath}'.`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Fix the path and re-report, or skip this chunk.`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
      },
    };
  }

  if (!checkSentinel(content)) {
    return {
      next: state,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}' split chunk ${idx + 1}: output missing AGENT_COMPLETE sentinel.`,
          `Result file: ${resultPath}`,
          ``,
          `Options:`,
          `  retry with corrected path: ewh report --run ${runId} --step ${stepIdx} --result <path>`,
          `  skip chunk:                ewh report --run ${runId} --step ${stepIdx} --decision no`,
          `  abort:                     ewh report --run ${runId} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --result ${resultPath}`,
      },
    };
  }

  return advanceSplitOrMerge(step, state, run, opts);
}

async function advanceSplitOrMerge(
  step: Step,
  state: Extract<StepState, { phase: 'split' }>,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const nextCompleted = [...state.completed];
  nextCompleted[state.current_chunk_index] = true;
  const nextIdx = state.current_chunk_index + 1;

  if (nextIdx >= state.chunks.length) {
    const mergeState: Extract<StepState, { phase: 'split_merge' }> = {
      phase: 'split_merge',
      chunks: state.chunks,
      rules: state.rules,
    };
    return executeSplitMerge(step, mergeState, run, opts);
  }

  const nextState: Extract<StepState, { phase: 'split' }> = {
    ...state,
    completed: nextCompleted,
    current_chunk_index: nextIdx,
  };
  const instruction = await buildSplitInstruction(step, nextState, nextIdx, run, opts);
  return { next: nextState, instruction };
}

// ── Phase 6: split_merge ───────────────────────────────────────────────────

async function executeSplitMerge(
  step: Step,
  state: Extract<StepState, { phase: 'split_merge' }>,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  const parts: string[] = [];
  let present = 0;
  let missing = 0;

  for (let i = 0; i < state.chunks.length; i++) {
    const chunk = state.chunks[i]!;
    let body: string;
    try {
      body = await fs.readFile(chunk.result_path, 'utf8');
      // Strip sentinel so the merged file doesn't repeat AGENT_COMPLETE.
      body = body
        .split('\n')
        .filter((l) => l.trim() !== SENTINEL)
        .join('\n')
        .trimEnd();
      present += 1;
    } catch {
      body = `_(split chunk ${i + 1}: no output on disk)_`;
      missing += 1;
    }
    parts.push(`## Split Result ${i + 1}\n\n${body}\n`);
  }

  const merged = parts.join('\n');

  if (step.artifact) {
    const absTarget = resolve(opts.projectRoot, step.artifact);
    await fs.mkdir(dirname(absTarget), { recursive: true });
    await fs.writeFile(absTarget, merged, 'utf8');
  }

  const mergeNote = step.artifact
    ? `split results merged → ${step.artifact} (${present} present, ${missing} missing)`
    : `split results combined (${present} present, ${missing} missing; no artifact declared)`;

  const summary: StepSummary = {
    step_name: step.name,
    outcome: 'completed',
    notes: mergeNote,
  };

  return enterArtifactVerify(step, state.rules, summary, run, opts);
}

// ── Phase 6: artifact_verify ───────────────────────────────────────────────

async function enterArtifactVerify(
  step: Step,
  rules: Rule[],
  summary: StepSummary,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (!step.artifact) {
    return runComplianceCheck(step, rules, summary, run, opts);
  }

  const artifactPath = resolve(opts.projectRoot, step.artifact);
  try {
    await fs.access(artifactPath);
    return runComplianceCheck(step, rules, summary, run, opts);
  } catch {
    const next: StepState = {
      phase: 'artifact_verify',
      pending_summary: summary,
      pending_rules: rules,
    };
    const runId = run.run_id;
    const stepIdx = run.current_step_index;
    return {
      next,
      instruction: {
        kind: 'user-prompt',
        body: [
          `Step '${step.name}': declared artifact '${step.artifact}' not found on disk.`,
          `Expected at: ${artifactPath}`,
          ``,
          `Options:`,
          `  retry (after writing artifact): ewh report --run ${runId} --step ${stepIdx} --decision yes`,
          `  skip this step:                 ewh report --run ${runId} --step ${stepIdx} --decision no`,
          `  abort:                          ewh report --run ${runId} --abort`,
        ].join('\n'),
        report_with: `ewh report --run ${runId} --step ${stepIdx} --decision yes`,
      },
    };
  }
}

async function handleArtifactVerifyEvent(
  step: Step,
  state: Extract<StepState, { phase: 'artifact_verify' }>,
  event: StepEvent,
  run: RunState,
  opts: TransitionOpts,
): Promise<TransitionResult> {
  if (event.kind === 'enter') {
    // Crash recovery: re-check the artifact.
    return enterArtifactVerify(step, state.pending_rules, state.pending_summary, run, opts);
  }

  if (event.report.kind !== 'decision') {
    throw new Error(`artifact_verify expects a decision report; got ${event.report.kind}`);
  }

  if (event.report.decision === 'no') {
    return {
      next: { phase: 'skipped', reason: 'artifact missing — skipped by user' },
      instruction: doneOrNext(run, step, 'skipped'),
    };
  }

  // yes → re-check artifact.
  return enterArtifactVerify(step, state.pending_rules, state.pending_summary, run, opts);
}

function completeNoop(step: Step, run: RunState): TransitionResult {
  const next: StepState = {
    phase: 'complete',
    summary: {
      step_name: step.name,
      outcome: 'completed',
      notes: step.message ?? step.description,
    },
  };
  return {
    next,
    instruction: doneOrNext(run, step, 'completed'),
  };
}

function doneOrNext(
  run: RunState,
  justFinished: Step,
  outcome: 'completed' | 'skipped',
): Instruction {
  const isLast = run.current_step_index >= run.steps.length - 1;
  const line = `Step '${justFinished.name}' ${outcome}.`;
  if (isLast) {
    return {
      kind: 'done',
      body: `${line}\nWorkflow '${run.workflow}' finished.`,
    };
  }
  return {
    kind: 'user-prompt',
    body: `${line} Advancing to next step.`,
    report_with: '__CONTINUE__',
  };
}

export async function advanceRun(run: RunState): Promise<Step | null> {
  if (run.current_step_index >= run.steps.length - 1) {
    run.status = 'complete';
    return null;
  }
  run.current_step_index += 1;
  const next = run.steps[run.current_step_index]!;
  next.state = { phase: 'pending' };
  return next;
}
