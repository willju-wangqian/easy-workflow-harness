/**
 * `ewh manage <workflow>` — walk each step of a contract and ask the user
 * about every runtime field in order: context → produces → gate → requires →
 * chunked → script → script_fallback. On completion, atomically writes the
 * updated JSON and re-renders the workflow.md summary.
 *
 * The state machine keeps a run-local draft JSON under `.ewh-artifacts/<run>/`
 * and only commits it to `.claude/ewh-workflows/<name>.json` after the last
 * field of the last step is answered. Idempotence: if every field report
 * preserves the current value, the committed JSON is byte-identical to the
 * starting contract (both normalize through loadContract/JSON.stringify).
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { glob } from 'glob';
import type {
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import { runDir } from '../state/store.js';
import type {
  ContextEntry,
  ContractStep,
  WorkflowContract,
} from '../workflow/contract.js';
import { loadContract, resolveContractPath } from '../workflow/contract-loader.js';
import { renderWorkflowMd } from '../workflow/render-md.js';
import { loadAgent } from '../workflow/agent-loader.js';

export type ManageField =
  | 'context'
  | 'produces'
  | 'gate'
  | 'requires'
  | 'chunked'
  | 'script'
  | 'script_fallback';

const FIELD_ORDER: ManageField[] = [
  'context',
  'produces',
  'gate',
  'requires',
  'chunked',
  'script',
  'script_fallback',
];

export type ManageStartOptions = {
  projectRoot: string;
  pluginRoot: string;
  runId: string;
  workflowName: string;
};

export type ManageResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

// ── start ────────────────────────────────────────────────────────────────

export async function startManage(opts: ManageStartOptions): Promise<ManageResult> {
  const name = opts.workflowName.trim();
  if (!name) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: [
          'ewh manage: missing workflow name.',
          '',
          'Usage: /ewh:doit manage <workflow-name>',
        ].join('\n'),
      },
    };
  }
  const contractPath = await resolveContractPath(opts.projectRoot, name);
  if (!contractPath) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: [
          `ewh manage: no contract found at .claude/ewh-workflows/${name}.json.`,
          '',
          `Run /ewh:doit design ${name} first to create the skeleton.`,
        ].join('\n'),
      },
    };
  }

  let contract: WorkflowContract;
  try {
    contract = await loadContract(contractPath);
  } catch (err) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: `ewh manage: could not load contract: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }
  if (contract.steps.length === 0) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: `ewh manage: workflow '${name}' has no steps. Nothing to manage.`,
      },
    };
  }

  const draftPath = managePaths(opts.projectRoot, opts.runId).draft;
  await fs.mkdir(dirname(draftPath), { recursive: true });
  await atomicWriteJson(draftPath, contract);

  const state: Extract<SubcommandState, { kind: 'manage' }> = {
    kind: 'manage',
    phase: 'field',
    workflow_name: name,
    contract_path: contractPath,
    draft_path: draftPath,
    step_index: 0,
    field: 'context',
  };
  const instruction = await renderFieldPrompt(state, {
    projectRoot: opts.projectRoot,
    pluginRoot: opts.pluginRoot,
    runId: opts.runId,
  });
  return { state, instruction };
}

// ── continue ─────────────────────────────────────────────────────────────

export type ManageContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueManage(
  run: RunState,
  report: Report,
  opts: ManageContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'manage') {
    throw new Error('manage report called with non-manage subcommand state');
  }
  if (report.kind === 'error') {
    throw new Error(`manage: unexpected error report: ${report.message}`);
  }

  const draft = await readDraft(sub.draft_path);
  const step = draft.steps[sub.step_index];
  if (!step) {
    throw new Error(
      `manage: step_index ${sub.step_index} out of range (0..${draft.steps.length - 1})`,
    );
  }

  const outcome = await applyFieldReport(sub.field, step, report);
  const ctx: RenderCtx = {
    projectRoot: opts.projectRoot,
    pluginRoot: opts.pluginRoot,
    runId: run.run_id,
  };

  if (!outcome.ok) {
    run.subcommand_state = sub;
    return renderFieldPrompt(sub, ctx, outcome.errorNote);
  }

  await atomicWriteJson(sub.draft_path, draft);

  const fieldIdx = FIELD_ORDER.indexOf(sub.field);
  if (fieldIdx < FIELD_ORDER.length - 1) {
    const next: Extract<SubcommandState, { kind: 'manage' }> = {
      ...sub,
      field: FIELD_ORDER[fieldIdx + 1]!,
    };
    run.subcommand_state = next;
    return renderFieldPrompt(next, ctx);
  }
  if (sub.step_index < draft.steps.length - 1) {
    const next: Extract<SubcommandState, { kind: 'manage' }> = {
      ...sub,
      step_index: sub.step_index + 1,
      field: 'context',
    };
    run.subcommand_state = next;
    return renderFieldPrompt(next, ctx);
  }

  const finalContract = await readDraft(sub.draft_path);
  await atomicWriteJson(sub.contract_path, finalContract);
  const mdPath = join(
    opts.projectRoot,
    '.claude',
    'ewh-workflows',
    `${sub.workflow_name}.md`,
  );
  await atomicWriteText(mdPath, renderWorkflowMd(finalContract));

  run.subcommand_state = undefined;
  return {
    kind: 'done',
    body: [
      `Saved workflow '${sub.workflow_name}':`,
      `  ~ ${relativeToProject(opts.projectRoot, sub.contract_path)}`,
      `  ~ ${relativeToProject(opts.projectRoot, mdPath)}`,
    ].join('\n'),
  };
}

// ── field dispatcher ─────────────────────────────────────────────────────

type FieldOutcome = { ok: true } | { ok: false; errorNote: string };

async function applyFieldReport(
  field: ManageField,
  step: ContractStep,
  report: Report,
): Promise<FieldOutcome> {
  switch (field) {
    case 'context':
    case 'produces':
    case 'requires':
    case 'script':
      return applyListOrEditReport(field, step, report);
    case 'gate':
      return applyGateReport(step, report);
    case 'chunked':
      return applyChunkedReport(step, report);
    case 'script_fallback':
      return applyScriptFallbackReport(step, report);
  }
}

async function applyListOrEditReport(
  field: 'context' | 'produces' | 'requires' | 'script',
  step: ContractStep,
  report: Report,
): Promise<FieldOutcome> {
  if (report.kind === 'decision') {
    if (report.decision === 'yes') return { ok: true };
    // no = clear
    if (field === 'context') step.context = [];
    else if (field === 'produces') step.produces = [];
    else if (field === 'requires') step.requires = [];
    else step.script = null;
    return { ok: true };
  }
  if (report.kind !== 'result' || !report.result_path) {
    return {
      ok: false,
      errorNote: `expected --decision yes|no or --result <path>, got ${report.kind}`,
    };
  }
  let raw: string;
  try {
    raw = await fs.readFile(report.result_path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errorNote: `could not read ${report.result_path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (field === 'script') {
    const trimmed = raw.trim();
    step.script = trimmed.length === 0 ? null : trimmed;
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errorNote: `result file is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (field === 'context') {
    const v = validateContextArray(parsed);
    if (!v.ok) return { ok: false, errorNote: v.error };
    step.context = v.value;
    return { ok: true };
  }
  if (field === 'produces') {
    const v = validateStringArray(parsed, 'produces');
    if (!v.ok) return { ok: false, errorNote: v.error };
    step.produces = v.value;
    return { ok: true };
  }
  // requires
  const v = validateRequiresArray(parsed);
  if (!v.ok) return { ok: false, errorNote: v.error };
  step.requires = v.value;
  return { ok: true };
}

function applyGateReport(step: ContractStep, report: Report): FieldOutcome {
  if (report.kind !== 'decision') {
    return { ok: false, errorNote: `expected --decision yes|no, got ${report.kind}` };
  }
  if (report.decision === 'no') {
    step.gate = step.gate === 'structural' ? 'auto' : 'structural';
  }
  return { ok: true };
}

function applyChunkedReport(step: ContractStep, report: Report): FieldOutcome {
  if (report.kind !== 'decision') {
    return { ok: false, errorNote: `expected --decision yes|no, got ${report.kind}` };
  }
  if (report.decision === 'no') step.chunked = !step.chunked;
  return { ok: true };
}

function applyScriptFallbackReport(step: ContractStep, report: Report): FieldOutcome {
  if (report.kind !== 'decision') {
    return { ok: false, errorNote: `expected --decision yes|no, got ${report.kind}` };
  }
  if (report.decision === 'no') {
    step.script_fallback = step.script_fallback === 'gate' ? 'auto' : 'gate';
  }
  return { ok: true };
}

// ── field prompt renderer ────────────────────────────────────────────────

type RenderCtx = { projectRoot: string; pluginRoot: string; runId: string };
type ManageState = Extract<SubcommandState, { kind: 'manage' }>;

async function renderFieldPrompt(
  sub: ManageState,
  ctx: RenderCtx,
  errorNote?: string,
): Promise<Instruction> {
  const draft = await readDraft(sub.draft_path);
  const step = draft.steps[sub.step_index]!;
  const totalSteps = draft.steps.length;
  const paths = managePaths(ctx.projectRoot, ctx.runId);
  const editFile = fieldEditPath(paths.runRoot, sub.step_index, sub.field);

  const header: string[] = [
    `EWH manage — workflow '${sub.workflow_name}'`,
    `Step ${sub.step_index + 1}/${totalSteps}: '${step.name}' (agent: ${step.agent})`,
    `Field: ${sub.field}`,
    '',
  ];
  if (errorNote) {
    header.push(`Previous input rejected: ${errorNote}`, '');
  }

  switch (sub.field) {
    case 'context':
      return renderContextPrompt(sub, step, draft, header, editFile, ctx);
    case 'produces':
      return renderProducesPrompt(sub, step, header, editFile, ctx);
    case 'gate':
      return renderGatePrompt(sub, step, header, ctx);
    case 'requires':
      return renderRequiresPrompt(sub, step, header, editFile, ctx);
    case 'chunked':
      return renderChunkedPrompt(sub, step, header, ctx);
    case 'script':
      return renderScriptPrompt(sub, step, header, editFile, ctx);
    case 'script_fallback':
      return renderScriptFallbackPrompt(sub, step, header, ctx);
  }
}

async function renderContextPrompt(
  _sub: ManageState,
  step: ContractStep,
  draft: WorkflowContract,
  header: string[],
  editFile: string,
  ctx: RenderCtx,
): Promise<Instruction> {
  const rules = await listAvailableRules(ctx.projectRoot, ctx.pluginRoot);
  const upstreamArtifacts = draft.steps
    .slice(0, _sub.step_index)
    .flatMap((s) => s.produces);
  const defaults = await resolveAgentDefaults(
    step.agent,
    ctx.pluginRoot,
    ctx.projectRoot,
  );
  // Pre-selection: if context is already populated, mirror its current rule
  // picks; if empty, fall back to the agent's default_rules.
  const currentRuleRefs = step.context
    .filter((e) => e.type === 'rule')
    .map((e) => e.ref);
  const preselected = new Set(
    currentRuleRefs.length > 0 ? currentRuleRefs : defaults,
  );

  const body = [
    ...header,
    'Current context entries:',
    formatContextList(step.context),
    '',
    'Available rules (type: rule):',
    rules.length > 0
      ? rules.map((r) => `  ${preselected.has(r) ? '[x]' : '[ ]'} ${r}`).join('\n')
      : '  (none found under rules/ or .claude/rules/)',
    '',
    'Available upstream artifacts (type: artifact):',
    upstreamArtifacts.length > 0
      ? upstreamArtifacts.map((a) => `  ${a}`).join('\n')
      : '  (no earlier step declares any produces[])',
    '',
    `Pre-selected rules from agent '${step.agent}'.default_rules: ${
      defaults.length > 0 ? defaults.join(', ') : '(none)'
    }`,
    '',
    'Choose:',
    `  keep current: ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  clear all:    ewh report --run ${ctx.runId} --step 0 --decision no`,
    `  replace:      write a JSON array of {type, ref} entries to`,
    `                  ${editFile}`,
    `                then ewh report --run ${ctx.runId} --step 0 --result ${editFile}`,
    '',
    'JSON shape:',
    '  [',
    '    {"type": "rule",     "ref": "coding"},',
    '    {"type": "artifact", "ref": ".ewh-artifacts/plan.md"},',
    '    {"type": "file",     "ref": "docs/spec.md"}',
    '  ]',
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderProducesPrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  editFile: string,
  ctx: RenderCtx,
): Instruction {
  const current =
    step.produces.length > 0
      ? step.produces.map((p) => `  - ${p}`).join('\n')
      : '  (none)';
  const body = [
    ...header,
    'Current produces[]:',
    current,
    '',
    'Choose:',
    `  keep:    ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  clear:   ewh report --run ${ctx.runId} --step 0 --decision no`,
    `  replace: write JSON array of paths (strings) to`,
    `             ${editFile}`,
    `           then ewh report --run ${ctx.runId} --step 0 --result ${editFile}`,
    '',
    'Convention: artifact paths live under .ewh-artifacts/.',
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderGatePrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  ctx: RenderCtx,
): Instruction {
  const other = step.gate === 'structural' ? 'auto' : 'structural';
  const body = [
    ...header,
    `Current gate: ${step.gate}`,
    '',
    `  keep '${step.gate}':  ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  flip to '${other}': ewh report --run ${ctx.runId} --step 0 --decision no`,
    '',
    'structural = ask user per-step; auto = no per-step gate.',
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderRequiresPrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  editFile: string,
  ctx: RenderCtx,
): Instruction {
  const current =
    step.requires.length > 0
      ? JSON.stringify(step.requires, null, 2)
      : '  (none)';
  const body = [
    ...header,
    'Current requires[]:',
    current,
    '',
    'Choose:',
    `  keep:    ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  clear:   ewh report --run ${ctx.runId} --step 0 --decision no`,
    `  replace: write JSON array of requires entries to`,
    `             ${editFile}`,
    `           then ewh report --run ${ctx.runId} --step 0 --result ${editFile}`,
    '',
    'JSON shape — each entry is one of:',
    '  {"file_exists": ".ewh-artifacts/plan.md"}',
    '  {"prior_step": "plan", "has": "files_modified"}',
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderChunkedPrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  ctx: RenderCtx,
): Instruction {
  const other = !step.chunked;
  const body = [
    ...header,
    `Current chunked: ${step.chunked}`,
    '',
    `  keep (${step.chunked}): ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  flip to ${other}:       ewh report --run ${ctx.runId} --step 0 --decision no`,
    '',
    'Chunked steps enumerate files via glob patterns and spawn parallel',
    'workers. Mutually exclusive with script:.',
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderScriptPrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  editFile: string,
  ctx: RenderCtx,
): Instruction {
  const body = [
    ...header,
    `Current script: ${step.script ?? '(none — will run the agent)'}`,
    '',
    'Choose:',
    `  keep:   ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  clear:  ewh report --run ${ctx.runId} --step 0 --decision no`,
    `  set:    write the script path (one line, e.g. scripts/foo.sh) to`,
    `            ${editFile}`,
    `          then ewh report --run ${ctx.runId} --step 0 --result ${editFile}`,
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

function renderScriptFallbackPrompt(
  _sub: ManageState,
  step: ContractStep,
  header: string[],
  ctx: RenderCtx,
): Instruction {
  const other = step.script_fallback === 'gate' ? 'auto' : 'gate';
  const body = [
    ...header,
    `Current script_fallback: ${step.script_fallback}`,
    '',
    `  keep '${step.script_fallback}':  ewh report --run ${ctx.runId} --step 0 --decision yes`,
    `  flip to '${other}': ewh report --run ${ctx.runId} --step 0 --decision no`,
    '',
    "gate = stop on script failure; auto = fall back to the step's agent.",
  ].join('\n');
  return {
    kind: 'user-prompt',
    body,
    report_with: `ewh report --run ${ctx.runId} --step 0 --decision yes`,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function readDraft(path: string): Promise<WorkflowContract> {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw) as WorkflowContract;
}

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

function managePaths(projectRoot: string, runId: string): { runRoot: string; draft: string } {
  const runRoot = runDir(projectRoot, runId);
  return { runRoot, draft: join(runRoot, 'manage-draft.json') };
}

function fieldEditPath(
  runRoot: string,
  stepIndex: number,
  field: ManageField,
): string {
  return join(runRoot, `manage-step-${stepIndex}-${field}.json`);
}

export async function listAvailableRules(
  projectRoot: string,
  pluginRoot: string,
): Promise<string[]> {
  const dirs = [
    join(pluginRoot, 'rules'),
    join(projectRoot, '.claude', 'rules'),
  ];
  const names = new Set<string>();
  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch {
      continue;
    }
    const matches = await glob('**/*.md', { cwd: dir, nodir: true });
    for (const m of matches) {
      const base = m.split(/[\\/]/).pop() ?? m;
      if (base.endsWith('.md')) names.add(base.slice(0, -3));
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export async function resolveAgentDefaults(
  agentName: string,
  pluginRoot: string,
  projectRoot: string,
): Promise<string[]> {
  try {
    const agent = await loadAgent(agentName, pluginRoot, projectRoot);
    return agent.default_rules ?? [];
  } catch {
    return [];
  }
}

function formatContextList(ctx: ContextEntry[]): string {
  if (ctx.length === 0) return '  (none)';
  return ctx.map((e) => `  - ${e.type}: ${e.ref}`).join('\n');
}

function relativeToProject(projectRoot: string, path: string): string {
  if (path.startsWith(projectRoot + '/')) return path.slice(projectRoot.length + 1);
  return path;
}

// ── validators ───────────────────────────────────────────────────────────

function validateContextArray(
  input: unknown,
): { ok: true; value: ContextEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'must be a JSON array' };
  const out: ContextEntry[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `entry[${i}] must be an object` };
    }
    const r = raw as Record<string, unknown>;
    if (r.type !== 'rule' && r.type !== 'artifact' && r.type !== 'file') {
      return { ok: false, error: `entry[${i}].type must be 'rule' | 'artifact' | 'file'` };
    }
    if (typeof r.ref !== 'string' || r.ref.length === 0) {
      return { ok: false, error: `entry[${i}].ref must be a non-empty string` };
    }
    out.push({ type: r.type, ref: r.ref } as ContextEntry);
  }
  return { ok: true, value: out };
}

function validateStringArray(
  input: unknown,
  name: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: `${name} must be a JSON array` };
  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (typeof item !== 'string' || item.length === 0) {
      return { ok: false, error: `${name}[${i}] must be a non-empty string` };
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

function validateRequiresArray(
  input: unknown,
): { ok: true; value: ContractStep['requires'] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'requires must be a JSON array' };
  const out: ContractStep['requires'] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `requires[${i}] must be an object` };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.file_exists === 'string') {
      out.push({ file_exists: r.file_exists });
      continue;
    }
    if (typeof r.prior_step === 'string' && typeof r.has === 'string') {
      out.push({ prior_step: r.prior_step, has: r.has });
      continue;
    }
    return {
      ok: false,
      error: `requires[${i}] must be {file_exists: string} or {prior_step: string, has: string}`,
    };
  }
  return { ok: true, value: out };
}
