/**
 * `ewh cleanup` / `ewh cleanup --manage-tasks`.
 *
 * Bare mode iterates `ewh-state.json.cleanup_tasks`, emitting one bash
 * instruction per task. On task failure we emit a user-prompt gate
 * (`--decision yes` skips + continues, `--abort` halts).
 *
 * Manage mode scans the project for candidate commands, presents a proposal,
 * persists on confirm.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  CleanupTask,
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import {
  readEwhStateFile,
  writeEwhStateFile,
} from '../state/workflow-settings.js';

export type CleanupStartOptions = {
  projectRoot: string;
  pluginRoot: string;
  manageTasks?: boolean;
};

export type CleanupResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

// ── start ────────────────────────────────────────────────────────────────

export async function startCleanup(opts: CleanupStartOptions): Promise<CleanupResult> {
  if (opts.manageTasks) {
    return startManageTasks(opts);
  }
  return startBareCleanup(opts);
}

async function startBareCleanup(opts: CleanupStartOptions): Promise<CleanupResult> {
  const state = await readEwhStateFile(opts.projectRoot);
  const tasks = Array.isArray(state.cleanup_tasks) ? state.cleanup_tasks : [];
  if (tasks.length === 0) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: [
          'No cleanup tasks configured.',
          '',
          'Run `/ewh:doit cleanup --manage-tasks` to set them up.',
        ].join('\n'),
      },
    };
  }
  const subState: SubcommandState = {
    kind: 'cleanup',
    phase: 'running',
    tasks,
    index: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  return {
    state: subState,
    instruction: buildTaskInstruction(tasks[0]!, 0, tasks.length),
  };
}

async function startManageTasks(opts: CleanupStartOptions): Promise<CleanupResult> {
  const subState: SubcommandState = { kind: 'cleanup-manage', phase: 'scan' };
  const instruction: Instruction = {
    kind: 'bash',
    body: [
      'Scan the project for potential cleanup commands. Write a JSON array',
      'of candidates to this file. Each entry: {"name": "...", "command":',
      '"...", "description": "..."}. Then report the path via --result.',
      '',
      'Sources to inspect (ignore missing ones):',
      '  package.json scripts (test/lint/format/build)',
      '  Makefile targets (test/lint/fmt/clean)',
      '  Harness Config in CLAUDE.md (Test command / Check command / Doc build)',
      '  Conventions: prettier, eslint, ruff, pytest, cargo test, go vet',
      '',
      'Proposed output path:',
      `  ${manageScanPath(opts.projectRoot)}`,
      '',
      `When done: ewh report --run <id> --step 0 --result ${manageScanPath(opts.projectRoot)}`,
    ].join('\n'),
  };
  return { state: subState, instruction };
}

// ── continue ─────────────────────────────────────────────────────────────

export type CleanupContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueCleanup(
  run: RunState,
  report: Report,
  opts: CleanupContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || (sub.kind !== 'cleanup' && sub.kind !== 'cleanup-manage')) {
    throw new Error('cleanup report called with non-cleanup subcommand state');
  }
  if (sub.kind === 'cleanup') {
    return continueBareCleanup(run, sub, report);
  }
  return continueManageTasks(run, sub, report, opts);
}

function continueBareCleanup(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'cleanup' }>,
  report: Report,
): Instruction {
  if (sub.phase === 'task-failed') {
    if (report.kind !== 'decision') {
      throw new Error(`cleanup: expected --decision during task-failed, got ${report.kind}`);
    }
    if (report.decision === 'no') {
      const next: SubcommandState = {
        kind: 'cleanup',
        phase: 'running',
        tasks: sub.tasks,
        index: sub.index + 1,
        passed: sub.passed,
        failed: sub.failed,
        skipped: sub.skipped,
      };
      run.subcommand_state = next;
      return advanceOrSummarize(run, next);
    }
    // decision yes → treat as skip + continue
    const next: SubcommandState = {
      kind: 'cleanup',
      phase: 'running',
      tasks: sub.tasks,
      index: sub.index + 1,
      passed: sub.passed,
      failed: sub.failed,
      skipped: sub.skipped + 1,
    };
    run.subcommand_state = next;
    return advanceOrSummarize(run, next);
  }

  // phase: running
  if (report.kind === 'error') {
    const next: SubcommandState = {
      kind: 'cleanup',
      phase: 'task-failed',
      tasks: sub.tasks,
      index: sub.index,
      passed: sub.passed,
      failed: sub.failed + 1,
      skipped: sub.skipped,
      error_message: report.message,
    };
    run.subcommand_state = next;
    const task = sub.tasks[sub.index]!;
    return {
      kind: 'user-prompt',
      body: [
        `Task ${sub.index + 1}/${sub.tasks.length} '${task.name}' failed:`,
        `  command: ${task.command}`,
        `  error: ${report.message}`,
        '',
        'Skip this task and continue?',
        `  continue: ewh report --run ${run.run_id} --step 0 --decision yes`,
        `  abort:    ewh report --run ${run.run_id} --abort`,
      ].join('\n'),
      report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
    };
  }
  if (report.kind !== 'result') {
    throw new Error(`cleanup: unexpected report kind ${report.kind}`);
  }
  const next: SubcommandState = {
    kind: 'cleanup',
    phase: 'running',
    tasks: sub.tasks,
    index: sub.index + 1,
    passed: sub.passed + 1,
    failed: sub.failed,
    skipped: sub.skipped,
  };
  run.subcommand_state = next;
  return advanceOrSummarize(run, next);
}

function advanceOrSummarize(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'cleanup'; phase: 'running' }>,
): Instruction {
  if (sub.index >= sub.tasks.length) {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `Cleanup complete: ${sub.passed} passed, ${sub.failed} failed, ${sub.skipped} skipped.`,
    };
  }
  return buildTaskInstruction(sub.tasks[sub.index]!, sub.index, sub.tasks.length);
}

function buildTaskInstruction(task: CleanupTask, index: number, total: number): Instruction {
  const desc = task.description ? ` — ${task.description}` : '';
  return {
    kind: 'bash',
    body: [
      `Cleanup task ${index + 1}/${total}: ${task.name}${desc}`,
      `Run: ${task.command}`,
      '',
      'Report success with `--result <stdout-log-path>`, failure with `--error "<message>"`.',
    ].join('\n'),
  };
}

async function continueManageTasks(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'cleanup-manage' }>,
  report: Report,
  opts: CleanupContinueOptions,
): Promise<Instruction> {
  if (sub.phase === 'scan') {
    if (report.kind === 'error') {
      throw new Error(`cleanup --manage-tasks scan failed: ${report.message}`);
    }
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('cleanup --manage-tasks scan: expected --result <path>');
    }
    const next: SubcommandState = {
      kind: 'cleanup-manage',
      phase: 'propose',
      scan_result_path: report.result_path,
    };
    run.subcommand_state = next;
    // Use the parsed tasks directly for the preview instead of reading twice.
    const tasks = await parseCandidates(report.result_path);
    return {
      kind: 'user-prompt',
      body: [
        'Proposed cleanup tasks:',
        '',
        formatTaskTable(tasks),
        '',
        'Save these to .claude/ewh-state.json?',
        `  confirm: ewh report --run ${run.run_id} --step 0 --decision yes`,
        `  abort:   ewh report --run ${run.run_id} --abort`,
      ].join('\n'),
      report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
    };
  }
  if (sub.phase === 'propose') {
    if (report.kind !== 'decision') {
      throw new Error(`cleanup --manage-tasks propose: expected --decision, got ${report.kind}`);
    }
    if (report.decision === 'no') {
      run.subcommand_state = undefined;
      return { kind: 'done', body: 'Cleanup tasks unchanged.' };
    }
    const tasks = await parseCandidates(sub.scan_result_path);
    await persistCleanupTasks(opts.projectRoot, tasks);
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `Saved ${tasks.length} cleanup task(s) to .claude/ewh-state.json.`,
    };
  }
  throw new Error(`cleanup-manage: unhandled phase ${(sub as { phase: string }).phase}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

export function manageScanPath(projectRoot: string): string {
  return join(projectRoot, '.ewh-artifacts', 'cleanup-candidates.json');
}

export async function parseCandidates(path: string): Promise<CleanupTask[]> {
  const content = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`cleanup candidates file ${path} is not a JSON array`);
  }
  const tasks: CleanupTask[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.command !== 'string') continue;
    tasks.push({
      name: r.name,
      command: r.command,
      description: typeof r.description === 'string' ? r.description : undefined,
    });
  }
  return tasks;
}

export async function persistCleanupTasks(
  projectRoot: string,
  tasks: CleanupTask[],
): Promise<void> {
  const state = await readEwhStateFile(projectRoot);
  state.cleanup_tasks = tasks;
  await writeEwhStateFile(projectRoot, state);
}

function formatTaskTable(tasks: CleanupTask[]): string {
  if (tasks.length === 0) return '  (no tasks proposed)';
  const lines: string[] = [];
  tasks.forEach((t, i) => {
    const desc = t.description ?? '';
    lines.push(`  ${i + 1}. ${t.name}: ${t.command}${desc ? '  # ' + desc : ''}`);
  });
  return lines.join('\n');
}
