/**
 * `ewh migrate` — one-shot conversion from legacy `.claude/workflows/*.md`
 * (old YAML format) to the Context Contract pair
 * `.claude/ewh-workflows/<name>.{md,json}`.
 *
 * Flow:
 *   start  → scan `.claude/workflows/*.md`, emit a user-prompt listing
 *            per-file plans (new / overwrite / skip) with a single approve
 *            gate.
 *   report → on `--decision yes`, convert + write every source whose target
 *            is either new or marked for overwrite, then emit done with a
 *            summary. On `--decision no` / `--abort`, abort cleanly.
 *
 * Legacy field mapping:
 *   rules:            → context[{type:"rule", ref:<name>}]
 *   reads:            → context[{type:"artifact", ref:<path>}]
 *   artifact:         → produces: [<path>]
 *   gate/requires/
 *   chunked/script/
 *   script_fallback:  → preserved verbatim (with safe defaults if absent)
 *
 * Old YAML is left in place; users delete after verifying.
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  Instruction,
  Report,
  RunState,
  Step,
  SubcommandState,
  WorkflowDef,
} from '../state/types.js';
import type {
  ContextEntry,
  ContractStep,
  WorkflowContract,
} from '../workflow/contract.js';
import { loadWorkflow } from '../workflow/parse.js';
import { renderWorkflowMd } from '../workflow/render-md.js';

export type MigrateStartOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export type MigrateResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

export async function startMigrate(opts: MigrateStartOptions): Promise<MigrateResult> {
  const legacyDir = join(opts.projectRoot, '.claude', 'workflows');
  let names: string[];
  try {
    names = (await fs.readdir(legacyDir))
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: undefined,
        instruction: {
          kind: 'done',
          body: [
            'ewh migrate: nothing to do.',
            '',
            `No legacy workflows found at .claude/workflows/.`,
            'Use /ewh:doit design <workflow> to author a new contract.',
          ].join('\n'),
        },
      };
    }
    throw err;
  }
  if (names.length === 0) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: 'ewh migrate: nothing to do (.claude/workflows/ is empty).',
      },
    };
  }

  const sources = names.map((n) => join(legacyDir, n));
  const planLines: string[] = [];
  for (const src of sources) {
    const name = basename(src, '.md');
    const jsonTarget = join(
      opts.projectRoot,
      '.claude',
      'ewh-workflows',
      `${name}.json`,
    );
    const mdTarget = jsonTarget.replace(/\.json$/, '.md');
    const existing =
      (await pathExists(jsonTarget)) || (await pathExists(mdTarget));
    planLines.push(
      `  ${existing ? '~ OVERWRITE' : '+ NEW      '} .claude/ewh-workflows/${name}.{md,json}  ← .claude/workflows/${name}.md`,
    );
  }

  const subState: Extract<SubcommandState, { kind: 'migrate' }> = {
    kind: 'migrate',
    phase: 'confirm',
    sources,
  };

  const body = [
    `ewh migrate — convert ${sources.length} legacy workflow${sources.length === 1 ? '' : 's'} to the Context Contract format.`,
    '',
    'Plan:',
    ...planLines,
    '',
    'Mapping:',
    '  rules: [foo]              → context: [{type: "rule", ref: "foo"}]',
    '  reads: [path]             → context: [{type: "artifact", ref: "path"}]',
    '  artifact: path            → produces: ["path"]',
    '  gate/requires/chunked/script/script_fallback: preserved',
    '',
    'Legacy .claude/workflows/*.md files are left in place.',
    'After verifying the new contracts, delete the old files.',
    '',
    'Proceed?  yes = write all, no = abort.',
  ].join('\n');

  return {
    state: subState,
    instruction: { kind: 'user-prompt', body },
  };
}

export type MigrateContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueMigrate(
  run: RunState,
  report: Report,
  opts: MigrateContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'migrate') {
    throw new Error('migrate report called with non-migrate state');
  }
  if (report.kind !== 'decision') {
    throw new Error(`migrate expects --decision yes|no, got ${report.kind}`);
  }
  if (report.decision === 'no') {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: 'ewh migrate: aborted. No files written.',
    };
  }

  const converted: string[] = [];
  const skipped: Array<{ source: string; reason: string }> = [];

  for (const source of sub.sources) {
    const name = basename(source, '.md');
    const workflowsDir = join(opts.projectRoot, '.claude', 'ewh-workflows');
    const jsonTarget = join(workflowsDir, `${name}.json`);
    const mdTarget = join(workflowsDir, `${name}.md`);
    let legacy: WorkflowDef;
    try {
      legacy = await loadWorkflow(source);
    } catch (err) {
      skipped.push({
        source,
        reason: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    let contract: WorkflowContract;
    try {
      contract = legacyToContract(legacy);
    } catch (err) {
      skipped.push({
        source,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    await atomicWriteJson(jsonTarget, contract);
    await atomicWriteText(mdTarget, renderWorkflowMd(contract));
    converted.push(name);
  }

  run.subcommand_state = undefined;

  const summary: string[] = [];
  summary.push(`ewh migrate — converted ${converted.length} workflow${converted.length === 1 ? '' : 's'}:`);
  for (const n of converted) {
    summary.push(`  + .claude/ewh-workflows/${n}.json`);
    summary.push(`  + .claude/ewh-workflows/${n}.md`);
  }
  if (skipped.length > 0) {
    summary.push('');
    summary.push(`Skipped ${skipped.length}:`);
    for (const s of skipped) {
      summary.push(`  ! ${basename(s.source)}: ${s.reason}`);
    }
  }
  summary.push('');
  summary.push('Legacy .claude/workflows/*.md left in place. Delete after verifying.');
  summary.push('Run `/ewh:doit doctor` to validate the new contracts.');

  return { kind: 'done', body: summary.join('\n') };
}

// ── conversion ──────────────────────────────────────────────────────────

export function legacyToContract(legacy: WorkflowDef): WorkflowContract {
  const steps: ContractStep[] = legacy.steps.map((s, i) => legacyStepToContract(s, i));
  return {
    name: legacy.name,
    description: legacy.description ?? '',
    steps,
  };
}

function legacyStepToContract(step: Step, index: number): ContractStep {
  const agent =
    typeof step.agent === 'string' && step.agent.length > 0
      ? step.agent
      : '(unset)';
  const context: ContextEntry[] = [];
  for (const r of step.rules ?? []) {
    context.push({ type: 'rule', ref: r });
  }
  for (const p of step.reads ?? []) {
    context.push({ type: 'artifact', ref: p });
  }
  const produces: string[] = step.artifact ? [step.artifact] : [];
  const gate: 'structural' | 'auto' = step.gate === 'structural' ? 'structural' : 'auto';
  return {
    name: step.name || `step-${index + 1}`,
    agent,
    description: step.description ?? '',
    gate,
    produces,
    context,
    requires: normalizeRequires(step.requires),
    chunked: step.chunked === true,
    script: typeof step.script === 'string' && step.script.length > 0 ? step.script : null,
    script_fallback: step.script_fallback === 'auto' ? 'auto' : 'gate',
  };
}

function normalizeRequires(raw: unknown): ContractStep['requires'] {
  if (!Array.isArray(raw)) return [];
  const out: ContractStep['requires'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.file_exists === 'string') {
      out.push({ file_exists: r.file_exists });
    } else if (typeof r.prior_step === 'string' && typeof r.has === 'string') {
      out.push({ prior_step: r.prior_step, has: r.has });
    }
  }
  return out;
}

// ── IO helpers ──────────────────────────────────────────────────────────

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, JSON.stringify(value, null, 2) + '\n');
}

async function atomicWriteText(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
