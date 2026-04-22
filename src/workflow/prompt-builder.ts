/**
 * Assembles the full agent prompt and writes it to disk.
 *
 * Section order (from CLAUDE.md §Key Contracts):
 *   agent template → ## Required Reading → ## Active Rules →
 *   ## Prior Steps → ## Task → ## Project Context
 *
 * Both `## Required Reading` and `## Prior Steps` are omitted when empty.
 * `## Project Context` is omitted when no Harness Config is found.
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ContextRef, RunState, Step, StepSummary } from '../state/types.js';
import type { LoadedAgent } from './agent-loader.js';
import type { LoadedRule } from './rule-loader.js';

export type BuiltPrompt = {
  promptPath: string;
  resultPath: string;
};

export type PriorStepContext = {
  ref: ContextRef;
  summary: StepSummary;
};

export async function buildPrompt(params: {
  step: Step;
  agent: LoadedAgent;
  rules: LoadedRule[];
  run: RunState;
  priorSteps: PriorStepContext[];
  harnessConfig: string | undefined;
  runDirPath: string;
  stepIndex: number;
  projectRoot: string;
}): Promise<BuiltPrompt> {
  const {
    step,
    agent,
    rules,
    run,
    priorSteps,
    harnessConfig,
    runDirPath,
    stepIndex,
    projectRoot,
  } = params;

  const parts: string[] = [];

  // 1. Agent template
  parts.push(agent.body);

  // 2. Required Reading — typed context entries (JSON contract) take
  //    precedence when present. Rule entries are skipped here (they
  //    surface under ## Active Rules, loaded by the state machine);
  //    artifact + file entries land in this section.
  const reads = collectRequiredReading(step);
  if (reads.length > 0) {
    const paths = reads.map((r) => resolve(projectRoot, r));
    parts.push(
      `## Required Reading\n\nRead the following files before starting:\n${paths.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  // 3. Active Rules
  if (rules.length > 0) {
    const bodies = rules.map((r) => {
      const header = r.name ? `### ${r.name}\n\n` : '';
      return `${header}${r.body}`;
    });
    parts.push(`## Active Rules\n\n${bodies.join('\n\n---\n\n')}`);
  }

  // 4. Prior Steps
  if (priorSteps.length > 0) {
    const formatted = priorSteps
      .map(({ ref, summary }) => formatPriorStep(ref, summary))
      .join('\n\n');
    parts.push(`## Prior Steps\n\n${formatted}`);
  }

  // 5. Task
  const taskBody = step.description ?? step.name;
  const artifactNote = step.artifact
    ? `\n\nWrite your primary output to \`${step.artifact}\`.`
    : '';
  parts.push(`## Task\n\n${taskBody}${artifactNote}`);

  // 6. Project Context
  if (harnessConfig) {
    parts.push(`## Project Context\n\n${harnessConfig}`);
  }

  const promptContent = parts.join('\n\n') + '\n';
  const promptPath = join(runDirPath, `step-${stepIndex}-prompt.md`);
  const resultPath = join(runDirPath, `step-${stepIndex}-output.md`);

  await fs.mkdir(runDirPath, { recursive: true });
  await fs.writeFile(promptPath, promptContent, 'utf8');

  return { promptPath, resultPath };
}

/**
 * Pick the paths that belong under ## Required Reading.
 *
 * When a step carries typed `context_entries` (JSON-contract path),
 * the entries themselves are the source of truth: artifact + file refs
 * flow into Required Reading; rule refs are handled separately via the
 * `rules` parameter (loaded by the state machine). Legacy YAML workflows
 * have no `context_entries` and fall back to `step.reads`.
 */
function collectRequiredReading(step: Step): string[] {
  if (step.context_entries && step.context_entries.length > 0) {
    return step.context_entries
      .filter((e) => e.type === 'artifact' || e.type === 'file')
      .map((e) => e.ref);
  }
  return step.reads ?? [];
}

function formatPriorStep(ref: ContextRef, summary: StepSummary): string {
  const lines: string[] = [`### ${ref.step} (${ref.detail})\n`];
  lines.push(`Outcome: ${summary.outcome}`);
  if (summary.notes) lines.push(`Notes: ${summary.notes}`);
  if (summary.files_modified?.length) {
    lines.push('Files modified:');
    for (const f of summary.files_modified) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}

/**
 * Heuristic extractor for files_modified from agent structured output.
 * Looks for a `files_modified:` YAML key followed by list items.
 */
export function extractFilesModified(content: string): string[] | undefined {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) =>
    /^-?\s*files_modified\s*:/i.test(l),
  );
  if (startIdx === -1) return undefined;

  // Check for inline bracket list: files_modified: [a, b, c]
  const inline = lines[startIdx]?.match(/:\s*\[(.+)\]/);
  if (inline?.[1]) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length ? items : undefined;
  }

  // YAML block list: lines following that start with '  - '
  const items: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i]?.match(/^\s+-\s+(.+)/);
    if (!m) break;
    items.push(m[1]!.trim());
  }
  return items.length ? items : undefined;
}
