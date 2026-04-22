/**
 * `ewh design "<description>"` — conversational interview to propose one or
 * more EWH artifacts (workflows, agents, rules), then a shape gate, per-file
 * authoring + gates, and finally atomic writes.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  Instruction,
  ModifyTarget,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import { runDir, writeRunState } from '../state/store.js';
import { buildCatalog, type CatalogEntry } from './design-catalog.js';
import type { WorkflowContract } from '../workflow/contract.js';
import { loadContract, resolveContractPath } from '../workflow/contract-loader.js';
import {
  checkIntegrity,
  diffContract,
  parseProposedInput,
  renderDiffSummary,
  type DiffResult,
} from '../workflow/contract-diff.js';
import { renderWorkflowMd } from '../workflow/render-md.js';
import { loadWorkflow } from '../workflow/parse.js';

export type DesignStartOptions = {
  projectRoot: string;
  pluginRoot: string;
  runId: string;
  description: string;
};

export type DesignResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

// ── Proposal schema ──────────────────────────────────────────────────────

export type ShapeArtifact = {
  type: 'workflow' | 'agent' | 'rule';
  op: 'create' | 'update';
  name: string;
  scope: 'plugin' | 'project';
  path: string;
  description: string;
  frontmatter: Record<string, unknown>;
  depends_on?: string[];
};

export type ShapeProposal = {
  description: string;
  artifacts: ShapeArtifact[];
};

// ── start ────────────────────────────────────────────────────────────────

export async function startDesign(opts: DesignStartOptions): Promise<DesignResult> {
  const description = opts.description.trim();
  if (!description) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: [
          'ewh design: missing description.',
          '',
          'Usage: /ewh:doit design "<describe what you want to design>"',
        ].join('\n'),
      },
    };
  }

  const paths = designPaths(opts.projectRoot, opts.runId);
  await fs.mkdir(paths.proposedDir, { recursive: true });

  const catalog = await buildCatalog(opts.projectRoot, opts.pluginRoot);
  await fs.writeFile(paths.catalog, JSON.stringify(catalog, null, 2), 'utf8');
  await fs.writeFile(paths.description, description + '\n', 'utf8');

  const modifyMatch = description.match(/^modify\s+(.+)$/);
  if (modifyMatch) {
    return startDesignModify({
      runId: opts.runId,
      projectRoot: opts.projectRoot,
      pluginRoot: opts.pluginRoot,
      spec: modifyMatch[1]!.trim(),
      catalog,
    });
  }

  if (isWorkflowName(description)) {
    const state: SubcommandState = {
      kind: 'design',
      phase: 'design_workflow_interview',
      workflow_name: description,
      catalog_path: paths.catalog,
      shape_path: paths.workflowShape,
    };
    return {
      state,
      instruction: buildWorkflowFacilitatorInstruction({
        runId: opts.runId,
        workflowName: description,
        catalogPath: paths.catalog,
        descriptionPath: paths.description,
        outputPath: paths.workflowShape,
      }),
    };
  }

  const state: SubcommandState = {
    kind: 'design',
    phase: 'interview',
    description,
    catalog_path: paths.catalog,
  };
  return {
    state,
    instruction: buildFacilitatorInstruction({
      runId: opts.runId,
      catalogPath: paths.catalog,
      descriptionPath: paths.description,
      outputPath: paths.shape,
    }),
  };
}

/**
 * Bare kebab/snake-case identifier => "design a workflow named <x>" mode.
 * Anything with whitespace or punctuation falls through to the generic
 * facilitator which designs rules, agents, or workflows from prose.
 */
export function isWorkflowName(description: string): boolean {
  return /^[a-z][a-z0-9_-]{1,62}$/.test(description);
}

// ── continue ─────────────────────────────────────────────────────────────

export type DesignContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueDesign(
  run: RunState,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'design') {
    throw new Error('design report called with non-design subcommand state');
  }
  switch (sub.phase) {
    case 'interview':
      return continueInterview(run, sub, report, opts);
    case 'shape_gate':
      return continueShapeGate(run, sub, report, opts);
    case 'author':
      return continueAuthor(run, sub, report, opts);
    case 'file_gate':
      return continueFileGate(run, sub, report, opts);
    case 'refine':
      return continueRefine(run, sub, report, opts);
    case 'write':
      return continueWrite(run, sub, opts);
    case 'design_workflow_interview':
      return continueWorkflowInterview(run, sub, report, opts);
    case 'design_workflow_template_gate':
      return continueWorkflowTemplateGate(run, sub, report, opts);
    case 'design_workflow_gate':
      return continueWorkflowGate(run, sub, report, opts);
    case 'design_workflow_write':
      return continueWorkflowWrite(run, sub, opts);
    case 'modify_ferry':
      return continueModifyFerry(run, sub, report, opts);
    case 'modify_review':
      return continueModifyReview(run, sub, report, opts);
  }
}

async function continueInterview(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'interview' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind === 'error') {
    throw new Error(`design interview: facilitator error: ${report.message}`);
  }
  if (report.kind !== 'result' || !report.result_path) {
    throw new Error('design interview: expected --result <shape.json path>');
  }

  const paths = designPaths(opts.projectRoot, run.run_id);
  const parsed = await readShape(report.result_path);
  if (!parsed.ok) {
    return bounceToInterview(run, sub, paths, [parsed.error]);
  }

  const catalog = await readCatalog(paths.catalog);
  const errors = validateShape(parsed.proposal, catalog);
  if (errors.length > 0) {
    return bounceToInterview(run, sub, paths, errors);
  }

  const isPlugin = await isInsidePluginRepo(opts.projectRoot);
  const notes: string[] = [];

  // In non-plugin projects: rewrite scope:plugin → scope:project
  if (!isPlugin) {
    const rewriteCount = await applyScopeRewrites(report.result_path, parsed.proposal);
    if (rewriteCount > 0) {
      notes.push(
        `Auto-rewrote ${rewriteCount} scope:plugin entr${rewriteCount === 1 ? 'y' : 'ies'} to scope:project (cross-project plugin edits not supported).`,
      );
    }
  }

  // In plugin repo: if any scope:project artifacts, prompt for confirmation first
  if (isPlugin) {
    const projectScopeCount = parsed.proposal.artifacts.filter((a) => a.scope === 'project').length;
    if (projectScopeCount > 0) {
      run.subcommand_state = {
        kind: 'design',
        phase: 'shape_gate',
        proposal_path: report.result_path,
        plugin_confirm_done: false,
      };
      return {
        kind: 'user-prompt',
        body: [
          'EWH design — plugin repo confirmation',
          '',
          `These ${projectScopeCount} artifact(s) will write to the plugin's own .claude/ directory.`,
          'Proceed? yes / no',
          '',
          `  yes: ewh report --run ${run.run_id} --step 0 --decision yes`,
          `  no:  ewh report --run ${run.run_id} --step 0 --decision no`,
        ].join('\n'),
        report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
      };
    }
  }

  run.subcommand_state = {
    kind: 'design',
    phase: 'shape_gate',
    proposal_path: report.result_path,
  };
  return renderShapeGate(run, parsed.proposal, paths, notes.length > 0 ? notes : undefined);
}

async function bounceToInterview(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'interview' }>,
  paths: DesignPaths,
  errors: string[],
): Promise<Instruction> {
  const note = [
    '',
    '--- validation errors from previous proposal ---',
    ...errors.map((e) => `  • ${e}`),
    'Please re-interview and re-emit shape.json addressing these issues.',
    '',
  ].join('\n');
  await fs.appendFile(paths.description, note, 'utf8');

  // Stay in interview phase; re-spawn the facilitator.
  run.subcommand_state = { ...sub };
  return buildFacilitatorInstruction({
    runId: run.run_id,
    catalogPath: paths.catalog,
    descriptionPath: paths.description,
    outputPath: paths.shape,
  });
}

async function continueShapeGate(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'shape_gate' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  // Handle plugin repo confirmation (plugin_confirm_done === false means pending)
  if (sub.plugin_confirm_done === false) {
    if (report.kind !== 'decision') {
      throw new Error(`design shape_gate plugin confirm: unexpected report kind '${report.kind}'`);
    }
    if (report.decision === 'no') {
      run.subcommand_state = undefined;
      return { kind: 'done', body: 'Aborted.' };
    }
    // User confirmed yes → proceed to shape gate
    const parsed = await readShape(sub.proposal_path);
    if (!parsed.ok) {
      run.subcommand_state = undefined;
      return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
    }
    run.subcommand_state = { ...sub, plugin_confirm_done: true };
    const paths = designPaths(opts.projectRoot, run.run_id);
    return renderShapeGate(run, parsed.proposal, paths);
  }

  // approve = decision yes, reject = decision no, edit = result (instruction file)
  if (report.kind === 'decision') {
    if (report.decision === 'yes') {
      const parsed = await readShape(sub.proposal_path);
      if (!parsed.ok) {
        run.subcommand_state = undefined;
        return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
      }
      const proposal = parsed.proposal;
      if (proposal.artifacts.length === 0) {
        run.subcommand_state = undefined;
        return { kind: 'done', body: 'ewh design: proposal has no artifacts to author.' };
      }
      const paths = designPaths(opts.projectRoot, run.run_id);
      run.subcommand_state = {
        kind: 'design',
        phase: 'author',
        proposal_path: sub.proposal_path,
        author_index: 0,
      };
      return buildAuthorInstruction({
        runId: run.run_id,
        artifact: proposal.artifacts[0]!,
        catalogPath: paths.catalog,
        stagedPath: stagedPathForArtifact(paths.proposedDir, proposal.artifacts[0]!),
        opts,
      });
    }
    // decision no → reject
    run.subcommand_state = undefined;
    return { kind: 'done', body: 'Proposal rejected. No files written.' };
  }
  if (report.kind === 'result') {
    // edit → append instruction to description and bounce back to interview
    if (!report.result_path) {
      throw new Error('design shape_gate edit: expected --result <instruction path>');
    }
    const instruction = (await fs.readFile(report.result_path, 'utf8')).trim();
    const paths = designPaths(opts.projectRoot, run.run_id);
    const note = [
      '',
      '--- user edit instruction after shape gate ---',
      instruction,
      '',
    ].join('\n');
    await fs.appendFile(paths.description, note, 'utf8');
    run.subcommand_state = {
      kind: 'design',
      phase: 'interview',
      description: instruction,
      catalog_path: paths.catalog,
    };
    return buildFacilitatorInstruction({
      runId: run.run_id,
      catalogPath: paths.catalog,
      descriptionPath: paths.description,
      outputPath: paths.shape,
    });
  }
  throw new Error(`design shape_gate: unexpected report kind '${report.kind}'`);
}

// ── facilitator invocation ───────────────────────────────────────────────

function buildFacilitatorInstruction(args: {
  runId: string;
  catalogPath: string;
  descriptionPath: string;
  outputPath: string;
}): Instruction {
  const body = [
    'Tool: Agent',
    'Args:',
    '  subagent_type: ewh:design-facilitator',
    '  prompt: |',
    '    You are the EWH design-facilitator. Interview the user via AskUserQuestion,',
    '    then write a shape.json proposal. Every question MUST include a',
    '    "propose now" option so the user can signal readiness at any turn.',
    '',
    `    catalog_path:     ${args.catalogPath}`,
    `    description_path: ${args.descriptionPath}`,
    `    output_path:      ${args.outputPath}`,
    '',
    '    Read description_path and catalog_path before your first question.',
    '    When ready, write the shape.json JSON document to output_path, list it',
    '    under `files_modified:`, then emit AGENT_COMPLETE.',
    `  description: "design: facilitator interview"`,
    '',
    `After the Agent tool returns, report: ewh report --run ${args.runId} --step 0 --result ${args.outputPath}`,
  ].join('\n');
  return {
    kind: 'tool-call',
    body,
    report_with: `ewh report --run ${args.runId} --step 0 --result ${args.outputPath}`,
  };
}

// ── shape gate rendering ─────────────────────────────────────────────────

function renderShapeGate(
  run: RunState,
  proposal: ShapeProposal,
  paths: DesignPaths,
  notes?: string[],
): Instruction {
  const editPath = paths.edit;
  const lines: string[] = [];

  if (notes && notes.length > 0) {
    for (const note of notes) lines.push(`Note: ${note}`);
    lines.push('');
  }

  lines.push('EWH design — shape gate');
  lines.push('');
  lines.push(`Description: ${proposal.description}`);
  lines.push('');
  lines.push(`Proposed ${proposal.artifacts.length} artifact(s):`);
  proposal.artifacts.forEach((a, i) => {
    const deps = a.depends_on && a.depends_on.length > 0 ? ` [depends: ${a.depends_on.join(', ')}]` : '';
    lines.push(`  ${i + 1}. [${a.op}] ${a.type} '${a.name}' (${a.scope}) → ${a.path}${deps}`);
    if (a.description) lines.push(`       ${a.description}`);
  });
  lines.push('');
  lines.push('Write order on approval: rules → agents → workflows.');
  lines.push('');
  lines.push('Choose:');
  lines.push(`  approve: ewh report --run ${run.run_id} --step 0 --decision yes`);
  lines.push(`  reject:  ewh report --run ${run.run_id} --step 0 --decision no`);
  lines.push(
    `  edit:    write your instruction (free-form text) to ${editPath},`,
  );
  lines.push(
    `           then ewh report --run ${run.run_id} --step 0 --result ${editPath}`,
  );
  return {
    kind: 'user-prompt',
    body: lines.join('\n'),
    report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
  };
}

// ── validation ───────────────────────────────────────────────────────────

type ShapeReadOk = { ok: true; proposal: ShapeProposal };
type ShapeReadErr = { ok: false; error: string };

async function readShape(path: string): Promise<ShapeReadOk | ShapeReadErr> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e: unknown) {
    return { ok: false, error: `failed to read shape.json at ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return { ok: false, error: `shape.json is not valid JSON: ${(e as Error).message}` };
  }
  return validateShapeShape(parsed);
}

function validateShapeShape(input: unknown): ShapeReadOk | ShapeReadErr {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'shape.json must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.description !== 'string') {
    return { ok: false, error: "shape.json missing required field 'description' (string)" };
  }
  if (!Array.isArray(obj.artifacts)) {
    return { ok: false, error: "shape.json missing required field 'artifacts' (array)" };
  }
  const artifacts: ShapeArtifact[] = [];
  for (let i = 0; i < obj.artifacts.length; i++) {
    const raw = obj.artifacts[i];
    const r = validateArtifact(raw, i);
    if (!r.ok) return r;
    artifacts.push(r.artifact);
  }
  return { ok: true, proposal: { description: obj.description, artifacts } };
}

function validateArtifact(
  raw: unknown,
  index: number,
): { ok: true; artifact: ShapeArtifact } | ShapeReadErr {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `artifacts[${index}] must be an object` };
  }
  const a = raw as Record<string, unknown>;
  const stringField = (k: string): string | null =>
    typeof a[k] === 'string' && (a[k] as string).length > 0 ? (a[k] as string) : null;
  const type = stringField('type');
  const op = stringField('op');
  const name = stringField('name');
  const scope = stringField('scope');
  const path = stringField('path');
  const description = stringField('description') ?? '';
  if (type !== 'workflow' && type !== 'agent' && type !== 'rule') {
    return { ok: false, error: `artifacts[${index}].type must be one of workflow|agent|rule` };
  }
  if (op !== 'create' && op !== 'update') {
    return { ok: false, error: `artifacts[${index}].op must be 'create' or 'update'` };
  }
  if (!name) return { ok: false, error: `artifacts[${index}].name is required` };
  if (scope !== 'plugin' && scope !== 'project') {
    return { ok: false, error: `artifacts[${index}].scope must be 'plugin' or 'project'` };
  }
  if (!path) return { ok: false, error: `artifacts[${index}].path is required` };
  const fm = a.frontmatter;
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return { ok: false, error: `artifacts[${index}].frontmatter must be an object` };
  }
  let depends_on: string[] | undefined;
  if (a.depends_on !== undefined) {
    if (!Array.isArray(a.depends_on)) {
      return { ok: false, error: `artifacts[${index}].depends_on must be an array` };
    }
    depends_on = a.depends_on.filter((d): d is string => typeof d === 'string');
  }
  return {
    ok: true,
    artifact: {
      type,
      op,
      name,
      scope,
      path,
      description,
      frontmatter: fm as Record<string, unknown>,
      depends_on,
    },
  };
}

/**
 * Validate a proposal against the EWH catalog.
 *
 * Rules:
 *   - Every `op: update` path must exist in the catalog.
 *   - Every `op: create` path must NOT exist in the catalog.
 *   - Every `depends_on` entry must be either in the same batch or in the catalog.
 *
 * Matching is `scope:path` (same-scope); cross-scope collisions are allowed
 * because plugin and project `.claude/` are separate namespaces.
 */
export function validateShape(proposal: ShapeProposal, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  const catalogKeys = new Set(catalog.map((e) => `${e.scope}:${e.path}`));
  const catalogNames = new Set(catalog.map((e) => e.name));
  const batchNames = new Set(proposal.artifacts.map((a) => a.name));

  for (const art of proposal.artifacts) {
    const key = `${art.scope}:${art.path}`;
    if (art.op === 'update' && !catalogKeys.has(key)) {
      errors.push(
        `artifact '${art.name}' is op:update but target ${art.scope}/${art.path} is not in the catalog`,
      );
    }
    if (art.op === 'create' && catalogKeys.has(key)) {
      errors.push(
        `artifact '${art.name}' is op:create but target ${art.scope}/${art.path} already exists in the catalog`,
      );
    }
    for (const dep of art.depends_on ?? []) {
      if (!batchNames.has(dep) && !catalogNames.has(dep)) {
        errors.push(
          `artifact '${art.name}' depends_on '${dep}' which is neither in this batch nor in the catalog`,
        );
      }
    }
  }
  return errors;
}

async function readCatalog(path: string): Promise<CatalogEntry[]> {
  const raw = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`catalog file ${path} is not a JSON array`);
  }
  return parsed as CatalogEntry[];
}

// ── paths ────────────────────────────────────────────────────────────────

type DesignPaths = {
  runRoot: string;
  proposedDir: string;
  catalog: string;
  description: string;
  shape: string;
  edit: string;
  workflowShape: string;
  workflowEdit: string;
};

export function designPaths(projectRoot: string, runId: string): DesignPaths {
  const runRoot = runDir(projectRoot, runId);
  const proposedDir = join(runRoot, 'proposed');
  return {
    runRoot,
    proposedDir,
    catalog: join(runRoot, 'catalog.json'),
    description: join(runRoot, 'description.txt'),
    shape: join(proposedDir, 'shape.json'),
    edit: join(runRoot, 'shape-edit.txt'),
    workflowShape: join(proposedDir, 'workflow-shape.json'),
    workflowEdit: join(runRoot, 'workflow-edit.txt'),
  };
}

// ── Artifact path helpers ─────────────────────────────────────────────────

function safeFilename(artifactPath: string): string {
  return artifactPath.replace(/[/\\]/g, '_');
}

export function stagedPathForArtifact(proposedDir: string, artifact: ShapeArtifact): string {
  return join(proposedDir, safeFilename(artifact.path));
}

function existingPathForArtifact(artifact: ShapeArtifact, opts: DesignContinueOptions): string {
  if (artifact.scope === 'plugin') {
    return join(opts.pluginRoot, artifact.path);
  }
  return join(opts.projectRoot, '.claude', artifact.path);
}

// ── Plugin-repo detection ─────────────────────────────────────────────────

export async function isInsidePluginRepo(projectRoot: string): Promise<boolean> {
  try {
    const body = await fs.readFile(join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(body) as { name?: unknown };
    return pkg.name === 'easy-workflow-harness';
  } catch {
    return false;
  }
}

// ── Scope rewrite ────────────────────────────────────────────────────────

async function applyScopeRewrites(proposalPath: string, proposal: ShapeProposal): Promise<number> {
  let count = 0;
  for (const a of proposal.artifacts) {
    if (a.scope === 'plugin') {
      a.scope = 'project';
      count++;
    }
  }
  if (count > 0) {
    await fs.writeFile(proposalPath, JSON.stringify(proposal, null, 2), 'utf8');
  }
  return count;
}

// ── Atomic file copy (staged → target) ───────────────────────────────────

async function atomicCopy(src: string, dst: string): Promise<void> {
  await fs.mkdir(dirname(dst), { recursive: true });
  const body = await fs.readFile(src, 'utf8');
  const tmp = `${dst}.tmp-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dst);
}

// ── Write phase ──────────────────────────────────────────────────────────

async function continueWrite(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'write' }>,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  const parsed = await readShape(sub.proposal_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
  }
  const proposal = parsed.proposal;
  const paths = designPaths(opts.projectRoot, run.run_id);

  const CLASS_ORDER: Record<string, number> = { rule: 0, agent: 1, workflow: 2 };
  const sorted = [...proposal.artifacts].sort(
    (a, b) => (CLASS_ORDER[a.type] ?? 3) - (CLASS_ORDER[b.type] ?? 3),
  );

  const written = [...(sub.written ?? [])];
  const summaryLines: string[] = [];

  for (const artifact of sorted) {
    const targetPath =
      artifact.scope === 'plugin'
        ? join(opts.pluginRoot, artifact.path)
        : join(opts.projectRoot, '.claude', artifact.path);
    const displayPath =
      artifact.scope === 'plugin' ? artifact.path : `.claude/${artifact.path}`;
    const sigil = artifact.op === 'create' ? '+' : '~';
    const suffix = artifact.op === 'update' ? '  (updated)' : '';

    if (written.includes(targetPath)) {
      summaryLines.push(`  ${sigil} ${displayPath}${suffix}`);
      continue;
    }

    if (artifact.op === 'create') {
      let exists = false;
      try {
        await fs.access(targetPath);
        exists = true;
      } catch { /* target absent — good */ }
      if (exists) {
        run.subcommand_state = undefined;
        return {
          kind: 'done',
          body: `ewh design: drift — target already exists: ${targetPath}. No further files written.`,
        };
      }
    } else {
      try {
        await fs.access(targetPath);
      } catch {
        run.subcommand_state = undefined;
        return {
          kind: 'done',
          body: `ewh design: update target missing: ${targetPath}. No further files written.`,
        };
      }
    }

    const stagedPath = stagedPathForArtifact(paths.proposedDir, artifact);
    await atomicCopy(stagedPath, targetPath);

    written.push(targetPath);
    run.subcommand_state = { ...sub, written };
    await writeRunState(opts.projectRoot, run);

    summaryLines.push(`  ${sigil} ${displayPath}${suffix}`);
  }

  run.subcommand_state = undefined;
  const n = summaryLines.length;
  const body = [
    `Wrote ${n} artifact${n === 1 ? '' : 's'}:`,
    ...summaryLines,
    '',
    'Next: /ewh:doit <workflow-name> "<description>" to try it.',
  ].join('\n');
  return { kind: 'done', body };
}

// ── Instruction builders ──────────────────────────────────────────────────

function buildAuthorInstruction(args: {
  runId: string;
  artifact: ShapeArtifact;
  catalogPath: string;
  stagedPath: string;
  opts: DesignContinueOptions;
}): Instruction {
  const { runId, artifact, catalogPath, stagedPath, opts } = args;
  const existingLine =
    artifact.op === 'update'
      ? [`    existing_path: ${existingPathForArtifact(artifact, opts)}`]
      : [];
  const body = [
    'Tool: Agent',
    'Args:',
    '  subagent_type: ewh:artifact-author',
    '  prompt: |',
    `    shape_entry: ${JSON.stringify(artifact)}`,
    '',
    `    catalog_path:  ${catalogPath}`,
    `    staged_path:   ${stagedPath}`,
    ...existingLine,
    '',
    '    Write the complete artifact body to staged_path.',
    '    For op:update, also write a unified diff to <staged_path>.diff.',
    '    After writing, emit AGENT_COMPLETE.',
    `  description: "design: author ${artifact.type} '${artifact.name}'"`,
    '',
    `After the Agent tool returns, report: ewh report --run ${runId} --step 0 --result ${stagedPath}`,
  ].join('\n');
  return {
    kind: 'tool-call',
    body,
    report_with: `ewh report --run ${runId} --step 0 --result ${stagedPath}`,
  };
}

function buildRefinerInstruction(args: {
  runId: string;
  stagedPath: string;
  instruction: string;
  existingPath: string | undefined;
}): Instruction {
  const { runId, stagedPath, instruction, existingPath } = args;
  const existingLine = existingPath ? [`    existing_path: ${existingPath}`] : [];
  const body = [
    'Tool: Agent',
    'Args:',
    '  subagent_type: ewh:artifact-refiner',
    '  prompt: |',
    `    staged_path:  ${stagedPath}`,
    `    instruction:  ${instruction}`,
    ...existingLine,
    '',
    '    Read staged_path, apply the instruction, overwrite in place.',
    '    If a .diff file exists at <staged_path>.diff, refresh it.',
    '    After writing, emit AGENT_COMPLETE.',
    `  description: "design: refine artifact"`,
    '',
    `After the Agent tool returns, report: ewh report --run ${runId} --step 0 --result ${stagedPath}`,
  ].join('\n');
  return {
    kind: 'tool-call',
    body,
    report_with: `ewh report --run ${runId} --step 0 --result ${stagedPath}`,
  };
}

// ── File-gate renderer ────────────────────────────────────────────────────

async function renderFileGate(
  run: RunState,
  proposal: ShapeProposal,
  fileIndex: number,
  paths: DesignPaths,
): Promise<Instruction> {
  const artifact = proposal.artifacts[fileIndex]!;
  const stagedPath = stagedPathForArtifact(paths.proposedDir, artifact);
  const total = proposal.artifacts.length;
  const editInstructionPath = join(paths.runRoot, `file-gate-${fileIndex}-edit.txt`);

  const lines: string[] = [];
  lines.push(`EWH design — file gate (${fileIndex + 1}/${total})`);
  lines.push('');
  lines.push(`[${artifact.op}] ${artifact.type} '${artifact.name}' → ${artifact.path}`);
  lines.push('');

  if (artifact.op === 'create') {
    const body = await fs.readFile(stagedPath, 'utf8');
    lines.push('--- staged file body ---');
    lines.push(body.trimEnd());
  } else {
    const diffPath = stagedPath + '.diff';
    try {
      const diff = await fs.readFile(diffPath, 'utf8');
      lines.push('--- unified diff ---');
      lines.push(diff.trimEnd());
    } catch {
      lines.push('[diff not available]');
    }
  }

  lines.push('');
  lines.push('Choose:');
  lines.push(`  approve: ewh report --run ${run.run_id} --step 0 --decision yes`);
  lines.push(`  reject:  ewh report --run ${run.run_id} --step 0 --decision no`);
  lines.push(`  edit:    write your edit instruction to ${editInstructionPath},`);
  lines.push(`           then ewh report --run ${run.run_id} --step 0 --result ${editInstructionPath}`);

  return {
    kind: 'user-prompt',
    body: lines.join('\n'),
    report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
  };
}

// ── Phase handlers ────────────────────────────────────────────────────────

async function continueAuthor(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'author' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind === 'error') {
    throw new Error(`design author: agent error: ${report.message}`);
  }
  if (report.kind !== 'result' || !report.result_path) {
    throw new Error('design author: expected --result <staged-path>');
  }

  const paths = designPaths(opts.projectRoot, run.run_id);
  const parsed = await readShape(sub.proposal_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
  }
  const proposal = parsed.proposal;
  const nextIndex = sub.author_index + 1;

  if (nextIndex < proposal.artifacts.length) {
    run.subcommand_state = {
      kind: 'design',
      phase: 'author',
      proposal_path: sub.proposal_path,
      author_index: nextIndex,
    };
    return buildAuthorInstruction({
      runId: run.run_id,
      artifact: proposal.artifacts[nextIndex]!,
      catalogPath: paths.catalog,
      stagedPath: stagedPathForArtifact(paths.proposedDir, proposal.artifacts[nextIndex]!),
      opts,
    });
  }

  // All artifacts authored → transition to file_gate
  run.subcommand_state = {
    kind: 'design',
    phase: 'file_gate',
    proposal_path: sub.proposal_path,
    file_index: 0,
  };
  return renderFileGate(run, proposal, 0, paths);
}

async function continueFileGate(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'file_gate' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  const parsed = await readShape(sub.proposal_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
  }
  const proposal = parsed.proposal;
  const artifact = proposal.artifacts[sub.file_index]!;
  const paths = designPaths(opts.projectRoot, run.run_id);

  if (report.kind === 'decision') {
    if (report.decision === 'yes') {
      const nextIndex = sub.file_index + 1;
      if (nextIndex >= proposal.artifacts.length) {
        // All files approved → execute write phase
        const writeState = {
          kind: 'design' as const,
          phase: 'write' as const,
          proposal_path: sub.proposal_path,
        };
        run.subcommand_state = writeState;
        return continueWrite(run, writeState, opts);
      }
      run.subcommand_state = {
        kind: 'design',
        phase: 'file_gate',
        proposal_path: sub.proposal_path,
        file_index: nextIndex,
      };
      return renderFileGate(run, proposal, nextIndex, paths);
    }
    // decision no → reject immediately, no partial writes
    const current = sub.file_index + 1;
    const total = proposal.artifacts.length;
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `Rejected file ${current}/${total} (${artifact.path}). No files written.`,
    };
  }

  if (report.kind === 'result') {
    if (!report.result_path) {
      throw new Error('design file_gate edit: expected --result <instruction path>');
    }
    const instruction = (await fs.readFile(report.result_path, 'utf8')).trim();
    const stagedPath = stagedPathForArtifact(paths.proposedDir, artifact);
    run.subcommand_state = {
      kind: 'design',
      phase: 'refine',
      proposal_path: sub.proposal_path,
      file_index: sub.file_index,
      instruction,
    };
    return buildRefinerInstruction({
      runId: run.run_id,
      stagedPath,
      instruction,
      existingPath: artifact.op === 'update' ? existingPathForArtifact(artifact, opts) : undefined,
    });
  }

  throw new Error(`design file_gate: unexpected report kind '${report.kind}'`);
}

async function continueRefine(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'refine' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind === 'error') {
    throw new Error(`design refine: agent error: ${report.message}`);
  }
  if (report.kind !== 'result' || !report.result_path) {
    throw new Error('design refine: expected --result <staged-path>');
  }

  const parsed = await readShape(sub.proposal_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return { kind: 'done', body: `ewh design: could not read proposal: ${parsed.error}` };
  }
  const proposal = parsed.proposal;

  // Refiner done → return to file_gate at same file_index (reads the now-refined file)
  run.subcommand_state = {
    kind: 'design',
    phase: 'file_gate',
    proposal_path: sub.proposal_path,
    file_index: sub.file_index,
  };
  const paths = designPaths(opts.projectRoot, run.run_id);
  return renderFileGate(run, proposal, sub.file_index, paths);
}

// ── Workflow-creation flow ────────────────────────────────────────────────

/**
 * Shape produced by the workflow-design facilitator. Narrower than
 * `ShapeProposal`: one workflow + its ordered list of steps, each with
 * `name`, `agent`, `description`. Runtime fields stay at safe defaults until
 * the user runs `manage`.
 */
export type WorkflowDraftStep = { name: string; agent: string; description: string };
export type WorkflowDraft = {
  name: string;
  description: string;
  steps: WorkflowDraftStep[];
};

type WorkflowShapeReadOk = { ok: true; draft: WorkflowDraft };
type WorkflowShapeReadErr = { ok: false; error: string };

export async function readWorkflowShape(
  path: string,
): Promise<WorkflowShapeReadOk | WorkflowShapeReadErr> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e: unknown) {
    return {
      ok: false,
      error: `failed to read workflow-shape.json at ${path}: ${(e as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return {
      ok: false,
      error: `workflow-shape.json is not valid JSON: ${(e as Error).message}`,
    };
  }
  return validateWorkflowDraft(parsed);
}

export function validateWorkflowDraft(
  input: unknown,
): WorkflowShapeReadOk | WorkflowShapeReadErr {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'workflow-shape.json must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, error: "workflow-shape.json 'name' must be a non-empty string" };
  }
  if (typeof obj.description !== 'string') {
    return { ok: false, error: "workflow-shape.json 'description' must be a string" };
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    return {
      ok: false,
      error: "workflow-shape.json 'steps' must be a non-empty array",
    };
  }
  const steps: WorkflowDraftStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.steps.length; i++) {
    const s = obj.steps[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, error: `steps[${i}] must be an object` };
    }
    const st = s as Record<string, unknown>;
    if (typeof st.name !== 'string' || st.name.length === 0) {
      return { ok: false, error: `steps[${i}].name must be a non-empty string` };
    }
    if (seen.has(st.name)) {
      return { ok: false, error: `steps[${i}].name '${st.name}' duplicates an earlier step` };
    }
    seen.add(st.name);
    if (typeof st.agent !== 'string' || st.agent.length === 0) {
      return {
        ok: false,
        error: `steps[${i}].agent must be a non-empty string (step '${st.name}')`,
      };
    }
    if (typeof st.description !== 'string') {
      return {
        ok: false,
        error: `steps[${i}].description must be a string (step '${st.name}')`,
      };
    }
    steps.push({ name: st.name, agent: st.agent, description: st.description });
  }
  return { ok: true, draft: { name: obj.name, description: obj.description, steps } };
}

/**
 * Convert a validated `WorkflowDraft` into a `WorkflowContract` skeleton with
 * runtime fields at safe defaults. `manage` fills them in later.
 */
export function draftToContract(draft: WorkflowDraft): WorkflowContract {
  return {
    name: draft.name,
    description: draft.description,
    steps: draft.steps.map((s) => ({
      name: s.name,
      agent: s.agent,
      description: s.description,
      gate: 'structural',
      produces: [],
      context: [],
      requires: [],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    })),
  };
}

function buildWorkflowFacilitatorInstruction(args: {
  runId: string;
  workflowName: string;
  catalogPath: string;
  descriptionPath: string;
  outputPath: string;
}): Instruction {
  const body = [
    'Tool: Agent',
    'Args:',
    '  subagent_type: ewh:design-facilitator',
    '  prompt: |',
    '    You are the EWH design-facilitator in workflow-creation mode. Your job',
    '    is to interview the user step-by-step (via AskUserQuestion) and output',
    '    a workflow-shape.json describing one workflow and its ordered list of',
    '    steps. Every question MUST include a "propose now" option so the user',
    '    can signal readiness at any turn.',
    '',
    `    workflow_name:    ${args.workflowName}`,
    `    catalog_path:     ${args.catalogPath}`,
    `    description_path: ${args.descriptionPath}`,
    `    output_path:      ${args.outputPath}`,
    '',
    '    Read catalog_path and description_path first. For each step, collect:',
    '      - name (short identifier, e.g. plan, code, review)',
    '      - agent (agent name; can be existing or new — a stub will be created)',
    '      - description (what this step does)',
    '',
    '    When done, write a JSON document to output_path with this exact shape:',
    '      {',
    `        "name": "${args.workflowName}",`,
    '        "description": "<what this workflow accomplishes>",',
    '        "steps": [',
    '          { "name": "...", "agent": "...", "description": "..." }',
    '        ]',
    '      }',
    '',
    '    List output_path under `files_modified:`, then emit AGENT_COMPLETE.',
    `  description: "design: workflow interview for '${args.workflowName}'"`,
    '',
    `After the Agent tool returns, report: ewh report --run ${args.runId} --step 0 --result ${args.outputPath}`,
  ].join('\n');
  return {
    kind: 'tool-call',
    body,
    report_with: `ewh report --run ${args.runId} --step 0 --result ${args.outputPath}`,
  };
}

async function continueWorkflowInterview(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'design_workflow_interview' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind === 'error') {
    throw new Error(`design workflow interview: facilitator error: ${report.message}`);
  }
  if (report.kind !== 'result' || !report.result_path) {
    throw new Error('design workflow interview: expected --result <workflow-shape.json path>');
  }

  const paths = designPaths(opts.projectRoot, run.run_id);
  const parsed = await readWorkflowShape(report.result_path);
  if (!parsed.ok) {
    return bounceWorkflowInterview(run, sub, paths, [parsed.error]);
  }
  if (parsed.draft.name !== sub.workflow_name) {
    return bounceWorkflowInterview(run, sub, paths, [
      `workflow-shape.json 'name' is '${parsed.draft.name}' but the user asked for '${sub.workflow_name}'`,
    ]);
  }

  // Persist the canonical shape path (facilitator may have written a different one).
  if (report.result_path !== sub.shape_path) {
    await fs.mkdir(dirname(sub.shape_path), { recursive: true });
    await fs.copyFile(report.result_path, sub.shape_path);
  }

  // Template match: plugin workflow with same name.
  const template = await findPluginTemplate(opts.pluginRoot, sub.workflow_name);
  if (template) {
    run.subcommand_state = {
      kind: 'design',
      phase: 'design_workflow_template_gate',
      workflow_name: sub.workflow_name,
      shape_path: sub.shape_path,
      template_path: template,
    };
    return renderWorkflowTemplateGate(run, sub.workflow_name, template, parsed.draft);
  }

  run.subcommand_state = {
    kind: 'design',
    phase: 'design_workflow_gate',
    workflow_name: sub.workflow_name,
    shape_path: sub.shape_path,
  };
  return renderWorkflowGate(run, parsed.draft, paths);
}

async function bounceWorkflowInterview(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'design_workflow_interview' }>,
  paths: DesignPaths,
  errors: string[],
): Promise<Instruction> {
  const note = [
    '',
    '--- validation errors from previous workflow-shape.json ---',
    ...errors.map((e) => `  • ${e}`),
    'Please re-interview and re-emit workflow-shape.json addressing these issues.',
    '',
  ].join('\n');
  await fs.appendFile(paths.description, note, 'utf8');
  run.subcommand_state = { ...sub };
  return buildWorkflowFacilitatorInstruction({
    runId: run.run_id,
    workflowName: sub.workflow_name,
    catalogPath: paths.catalog,
    descriptionPath: paths.description,
    outputPath: paths.workflowShape,
  });
}

async function findPluginTemplate(
  pluginRoot: string,
  workflowName: string,
): Promise<string | null> {
  const candidate = join(pluginRoot, 'workflows', `${workflowName}.md`);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function renderWorkflowTemplateGate(
  run: RunState,
  workflowName: string,
  templatePath: string,
  draft: WorkflowDraft,
): Instruction {
  const lines: string[] = [];
  lines.push(`EWH design — workflow template gate ('${workflowName}')`);
  lines.push('');
  lines.push(`A plugin template exists at: ${templatePath}`);
  lines.push('');
  lines.push(`Your draft has ${draft.steps.length} step(s):`);
  draft.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.name} — agent: ${s.agent}`);
  });
  lines.push('');
  lines.push('Use the plugin template as the starting point instead?');
  lines.push(`  yes: ewh report --run ${run.run_id} --step 0 --decision yes   (replace draft with template steps)`);
  lines.push(`  no:  ewh report --run ${run.run_id} --step 0 --decision no    (keep draft)`);
  return {
    kind: 'user-prompt',
    body: lines.join('\n'),
    report_with: `ewh report --run ${run.run_id} --step 0 --decision no`,
  };
}

async function continueWorkflowTemplateGate(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'design_workflow_template_gate' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind !== 'decision') {
    throw new Error(
      `design workflow template gate: unexpected report kind '${report.kind}'`,
    );
  }
  const paths = designPaths(opts.projectRoot, run.run_id);

  if (report.decision === 'yes') {
    // Replace the user's draft with a draft derived from the plugin template.
    const templateDraft = await draftFromTemplate(sub.template_path);
    templateDraft.name = sub.workflow_name; // user's target name wins
    await fs.mkdir(dirname(sub.shape_path), { recursive: true });
    await fs.writeFile(sub.shape_path, JSON.stringify(templateDraft, null, 2), 'utf8');
  }
  // Either way, advance to the final gate with whatever's in shape_path.
  const parsed = await readWorkflowShape(sub.shape_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `ewh design: could not read workflow shape: ${parsed.error}`,
    };
  }
  run.subcommand_state = {
    kind: 'design',
    phase: 'design_workflow_gate',
    workflow_name: sub.workflow_name,
    shape_path: sub.shape_path,
  };
  return renderWorkflowGate(run, parsed.draft, paths);
}

async function draftFromTemplate(templatePath: string): Promise<WorkflowDraft> {
  const def = await loadWorkflow(templatePath);
  return {
    name: def.name,
    description: def.description ?? '',
    steps: def.steps.map((s) => ({
      name: s.name,
      agent: s.agent ?? '',
      description: (s.description ?? '').trim(),
    })),
  };
}

function renderWorkflowGate(
  run: RunState,
  draft: WorkflowDraft,
  paths: DesignPaths,
): Instruction {
  const editPath = paths.workflowEdit;
  const lines: string[] = [];
  lines.push(`EWH design — workflow gate ('${draft.name}')`);
  lines.push('');
  lines.push(`Description: ${draft.description || '(none)'}`);
  lines.push('');
  lines.push(`Proposed ${draft.steps.length} step(s):`);
  draft.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.name} — agent: ${s.agent}`);
    if (s.description) lines.push(`       ${s.description}`);
  });
  lines.push('');
  lines.push('On approval, EWH will atomically write:');
  lines.push(`  - .claude/ewh-workflows/${draft.name}.json (contract skeleton)`);
  lines.push(`  - .claude/ewh-workflows/${draft.name}.md   (summary rendered from JSON)`);
  lines.push(`  - .claude/agents/<name>.md stubs for any agent not already present`);
  lines.push('');
  lines.push('Choose:');
  lines.push(`  approve: ewh report --run ${run.run_id} --step 0 --decision yes`);
  lines.push(`  reject:  ewh report --run ${run.run_id} --step 0 --decision no`);
  lines.push(`  edit:    write your instruction to ${editPath},`);
  lines.push(`           then ewh report --run ${run.run_id} --step 0 --result ${editPath}`);
  return {
    kind: 'user-prompt',
    body: lines.join('\n'),
    report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
  };
}

async function continueWorkflowGate(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'design_workflow_gate' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  const paths = designPaths(opts.projectRoot, run.run_id);

  if (report.kind === 'decision') {
    if (report.decision === 'yes') {
      const writeState = {
        kind: 'design' as const,
        phase: 'design_workflow_write' as const,
        workflow_name: sub.workflow_name,
        shape_path: sub.shape_path,
      };
      run.subcommand_state = writeState;
      return continueWorkflowWrite(run, writeState, opts);
    }
    run.subcommand_state = undefined;
    return { kind: 'done', body: 'Workflow proposal rejected. No files written.' };
  }

  if (report.kind === 'result') {
    if (!report.result_path) {
      throw new Error('design workflow gate edit: expected --result <instruction path>');
    }
    const instruction = (await fs.readFile(report.result_path, 'utf8')).trim();
    const note = [
      '',
      '--- user edit instruction after workflow gate ---',
      instruction,
      '',
    ].join('\n');
    await fs.appendFile(paths.description, note, 'utf8');
    run.subcommand_state = {
      kind: 'design',
      phase: 'design_workflow_interview',
      workflow_name: sub.workflow_name,
      catalog_path: paths.catalog,
      shape_path: sub.shape_path,
    };
    return buildWorkflowFacilitatorInstruction({
      runId: run.run_id,
      workflowName: sub.workflow_name,
      catalogPath: paths.catalog,
      descriptionPath: paths.description,
      outputPath: paths.workflowShape,
    });
  }

  throw new Error(`design workflow gate: unexpected report kind '${report.kind}'`);
}

/**
 * Atomic write of the workflow-creation outputs.
 *
 * Order: agent stubs (only for agents not already on disk) → workflow.json →
 * workflow.md. If any write fails, files this run created are rolled back;
 * pre-existing files are untouched.
 *
 * `sub.written` preserves crash-resume: already-written targets are skipped.
 * The workflow pair is always rewritten (the contract may have changed across
 * a re-run), agent stubs are never overwritten.
 */
async function continueWorkflowWrite(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'design_workflow_write' }>,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  const parsed = await readWorkflowShape(sub.shape_path);
  if (!parsed.ok) {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `ewh design: could not read workflow shape: ${parsed.error}`,
    };
  }
  const draft = parsed.draft;
  const contract = draftToContract(draft);
  const mdBody = renderWorkflowMd(contract);

  const workflowsDir = join(opts.projectRoot, '.claude', 'ewh-workflows');
  const agentsDir = join(opts.projectRoot, '.claude', 'agents');
  const jsonPath = join(workflowsDir, `${draft.name}.json`);
  const mdPath = join(workflowsDir, `${draft.name}.md`);

  const uniqueAgents = Array.from(new Set(draft.steps.map((s) => s.agent)));
  const stubTargets: Array<{ agent: string; path: string }> = [];
  for (const agent of uniqueAgents) {
    const pluginPath = join(opts.pluginRoot, 'agents', `${agent}.md`);
    const projectPath = join(opts.projectRoot, '.claude', 'agents', `${agent}.md`);
    const existsPlugin = await pathExists(pluginPath);
    const existsProject = await pathExists(projectPath);
    if (!existsPlugin && !existsProject) {
      stubTargets.push({ agent, path: projectPath });
    }
  }

  const written = [...(sub.written ?? [])];
  const newlyWritten: string[] = [];
  const summaryLines: string[] = [];

  try {
    // 1. agent stubs (only missing ones)
    for (const { agent, path } of stubTargets) {
      if (written.includes(path)) {
        summaryLines.push(`  + .claude/agents/${agent}.md  (stub, already written)`);
        continue;
      }
      const step = draft.steps.find((s) => s.agent === agent)!;
      const body = renderAgentStub(agent, step.description);
      await atomicWrite(path, body);
      written.push(path);
      newlyWritten.push(path);
      run.subcommand_state = { ...sub, written };
      await writeRunState(opts.projectRoot, run);
      summaryLines.push(`  + .claude/agents/${agent}.md  (stub)`);
    }

    // 2. workflow.json
    if (!written.includes(jsonPath)) {
      await atomicWrite(jsonPath, JSON.stringify(contract, null, 2) + '\n');
      written.push(jsonPath);
      newlyWritten.push(jsonPath);
      run.subcommand_state = { ...sub, written };
      await writeRunState(opts.projectRoot, run);
    }
    summaryLines.push(`  + .claude/ewh-workflows/${draft.name}.json`);

    // 3. workflow.md
    if (!written.includes(mdPath)) {
      await atomicWrite(mdPath, mdBody);
      written.push(mdPath);
      newlyWritten.push(mdPath);
      run.subcommand_state = { ...sub, written };
      await writeRunState(opts.projectRoot, run);
    }
    summaryLines.push(`  + .claude/ewh-workflows/${draft.name}.md`);
  } catch (err) {
    // Rollback: remove every file we newly created this run.
    for (const path of newlyWritten.reverse()) {
      try {
        await fs.unlink(path);
      } catch {
        // best-effort rollback
      }
    }
    run.subcommand_state = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'done',
      body: `ewh design: write failed and rolled back: ${msg}`,
    };
  }

  run.subcommand_state = undefined;
  const body = [
    `Wrote workflow '${draft.name}':`,
    ...summaryLines,
    '',
    `Next: /ewh:doit manage ${draft.name}   to fill runtime fields (context, produces, etc.)`,
  ].join('\n');
  return { kind: 'done', body };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}


// ── design modify ─────────────────────────────────────────────────────────

type StartDesignModifyOptions = {
  runId: string;
  projectRoot: string;
  pluginRoot: string;
  spec: string;
  catalog: CatalogEntry[];
};

async function startDesignModify(
  opts: StartDesignModifyOptions,
): Promise<DesignResult> {
  const parsed = parseModifyTarget(opts.spec);
  if (!parsed.ok) {
    return {
      state: undefined,
      instruction: {
        kind: 'done',
        body: [
          `ewh design modify: ${parsed.error}`,
          '',
          'Usage: /ewh:doit design modify <workflow>:<step>',
          '       /ewh:doit design modify <workflow>',
          '       /ewh:doit design modify agent:<name>',
          '       /ewh:doit design modify rule:<name>',
        ].join('\n'),
      },
    };
  }
  const target = parsed.target;

  let contractPath: string | null = null;
  let workflowName: string | null = null;
  if (target.kind === 'workflow-step' || target.kind === 'workflow') {
    workflowName = target.workflow;
    contractPath = await resolveContractPath(opts.projectRoot, workflowName);
    if (!contractPath) {
      return {
        state: undefined,
        instruction: {
          kind: 'done',
          body: [
            `ewh design modify: no contract at .claude/ewh-workflows/${workflowName}.json.`,
            '',
            `Run /ewh:doit design ${workflowName} first to create one.`,
          ].join('\n'),
        },
      };
    }
  }

  const runRoot = runDir(opts.projectRoot, opts.runId);
  const modifyDir = join(runRoot, `modify-${opts.runId}`);
  await fs.mkdir(modifyDir, { recursive: true });
  const contextPath = join(modifyDir, 'context.md');
  const proposedPath = join(modifyDir, 'proposed.json');

  await writeModifyContext({
    target,
    contractPath,
    contextPath,
    catalog: opts.catalog,
    projectRoot: opts.projectRoot,
    pluginRoot: opts.pluginRoot,
  });

  const state: SubcommandState = {
    kind: 'design',
    phase: 'modify_ferry',
    target,
    run_root: runRoot,
    context_path: contextPath,
    proposed_path: proposedPath,
    contract_path: contractPath,
    workflow_name: workflowName,
  };
  return {
    state,
    instruction: buildModifyFerryInstruction({
      runId: opts.runId,
      target,
      contextPath,
      proposedPath,
    }),
  };
}

type ParseModifyTargetResult =
  | { ok: true; target: ModifyTarget }
  | { ok: false; error: string };

export function parseModifyTarget(spec: string): ParseModifyTargetResult {
  const trimmed = spec.trim();
  if (!trimmed) return { ok: false, error: 'missing target (got empty string)' };
  if (trimmed.startsWith('agent:')) {
    const name = trimmed.slice('agent:'.length).trim();
    if (!name) return { ok: false, error: `missing agent name in '${spec}'` };
    return { ok: true, target: { kind: 'agent', name } };
  }
  if (trimmed.startsWith('rule:')) {
    const name = trimmed.slice('rule:'.length).trim();
    if (!name) return { ok: false, error: `missing rule name in '${spec}'` };
    return { ok: true, target: { kind: 'rule', name } };
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx >= 0) {
    const workflow = trimmed.slice(0, colonIdx).trim();
    const step = trimmed.slice(colonIdx + 1).trim();
    if (!workflow) return { ok: false, error: `missing workflow name in '${spec}'` };
    if (!step) return { ok: false, error: `missing step name in '${spec}'` };
    return { ok: true, target: { kind: 'workflow-step', workflow, step } };
  }
  return { ok: true, target: { kind: 'workflow', workflow: trimmed } };
}

type WriteModifyContextArgs = {
  target: ModifyTarget;
  contractPath: string | null;
  contextPath: string;
  catalog: CatalogEntry[];
  projectRoot: string;
  pluginRoot: string;
};

async function writeModifyContext(args: WriteModifyContextArgs): Promise<void> {
  const sections: string[] = [];
  sections.push(`# EWH design modify — context package`);
  sections.push('');
  sections.push(`Target: ${describeTarget(args.target)}`);
  sections.push('');

  if (args.contractPath) {
    const raw = await fs.readFile(args.contractPath, 'utf8');
    sections.push('## Current workflow contract (JSON)');
    sections.push('```json');
    sections.push(raw.trimEnd());
    sections.push('```');
    sections.push('');
  }

  if (args.target.kind === 'workflow-step') {
    const target = args.target;
    // Include the target step's agent body for reference.
    const contract = await loadContract(args.contractPath!);
    const step = contract.steps.find((s) => s.name === target.step);
    if (step) {
      const agentBody = await tryLoadAssetBody([
        join(args.projectRoot, '.claude', 'agents', `${step.agent}.md`),
        join(args.pluginRoot, 'agents', `${step.agent}.md`),
      ]);
      if (agentBody) {
        sections.push(`## Target agent: \`${step.agent}\``);
        sections.push('```markdown');
        sections.push(agentBody.trimEnd());
        sections.push('```');
        sections.push('');
      } else {
        sections.push(`## Target agent: \`${step.agent}\` — (no .md found)`);
        sections.push('');
      }
    } else {
      sections.push(
        `> Note: step '${target.step}' not found in current contract. Proposing an add.`,
      );
      sections.push('');
    }
  } else if (args.target.kind === 'agent') {
    const body = await tryLoadAssetBody([
      join(args.projectRoot, '.claude', 'agents', `${args.target.name}.md`),
      join(args.pluginRoot, 'agents', `${args.target.name}.md`),
    ]);
    sections.push(`## Target agent: \`${args.target.name}\``);
    sections.push('```markdown');
    sections.push((body ?? '(not found)').trimEnd());
    sections.push('```');
    sections.push('');
  } else if (args.target.kind === 'rule') {
    const body = await tryLoadAssetBody([
      join(args.projectRoot, '.claude', 'rules', `${args.target.name}.md`),
      join(args.pluginRoot, 'rules', `${args.target.name}.md`),
    ]);
    sections.push(`## Target rule: \`${args.target.name}\``);
    sections.push('```markdown');
    sections.push((body ?? '(not found)').trimEnd());
    sections.push('```');
    sections.push('');
  }

  // Catalog: names of all rules + declared-artifact paths across all workflows.
  const rules = args.catalog
    .filter((e) => e.type === 'rule')
    .map((e) => e.name)
    .sort();
  const artifacts = await collectDeclaredArtifacts(args.projectRoot);
  sections.push('## Catalog');
  sections.push('');
  sections.push('### Rules (by name)');
  if (rules.length) {
    for (const r of rules) sections.push(`- ${r}`);
  } else {
    sections.push('(none)');
  }
  sections.push('');
  sections.push('### Declared artifacts (produces paths, project-wide)');
  if (artifacts.length) {
    for (const a of artifacts) sections.push(`- ${a}`);
  } else {
    sections.push('(none)');
  }
  sections.push('');

  sections.push('## Protocol');
  sections.push('');
  sections.push(
    [
      'Converse with the user via AskUserQuestion. When ready, write an',
      'array of self-contained step slices as JSON to the output path. Each',
      'slice MUST include a `name`. For structural ops:',
      '',
      '- `"_delete": true` removes an existing step.',
      '- `"_rename_from": "<old>"` renames (cross-step refs are rewritten).',
      '',
      'Optional top-level reorder: wrap in an object and add `"_order": [...]`.',
      '',
      'Slice schema matches `ContractStep`: name, agent, description, gate,',
      'produces (string[]), context ({type: rule|artifact|file, ref}[]),',
      'requires, chunked, script, script_fallback. Missing fields are',
      'preserved from the current step (for updates/renames).',
    ].join('\n'),
  );
  sections.push('');

  await fs.writeFile(args.contextPath, sections.join('\n'), 'utf8');
}

function describeTarget(t: ModifyTarget): string {
  switch (t.kind) {
    case 'workflow-step':
      return `workflow '${t.workflow}', step '${t.step}'`;
    case 'workflow':
      return `workflow '${t.workflow}' (whole)`;
    case 'agent':
      return `agent '${t.name}'`;
    case 'rule':
      return `rule '${t.name}'`;
  }
}

async function tryLoadAssetBody(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      // next
    }
  }
  return null;
}

async function collectDeclaredArtifacts(projectRoot: string): Promise<string[]> {
  const dir = join(projectRoot, '.claude', 'ewh-workflows');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const contract = await loadContract(join(dir, name));
      for (const step of contract.steps) {
        for (const p of step.produces) out.add(p);
      }
    } catch {
      // skip unparseable
    }
  }
  return [...out].sort();
}

function buildModifyFerryInstruction(args: {
  runId: string;
  target: ModifyTarget;
  contextPath: string;
  proposedPath: string;
}): Instruction {
  const body = [
    'Tool: Agent',
    'Args:',
    '  subagent_type: ewh:design-facilitator',
    '  prompt: |',
    '    You are the EWH design-facilitator in modify mode. Your job is to',
    '    converse with the user (via AskUserQuestion) about the target',
    '    asset, then write an array of self-contained step slices to',
    '    output_path.',
    '',
    `    target:           ${describeTarget(args.target)}`,
    `    context_path:     ${args.contextPath}`,
    `    output_path:      ${args.proposedPath}`,
    '',
    '    Read context_path first. It contains the current contract JSON,',
    '    the target asset\'s body, and a catalog of available rules and',
    '    declared artifacts. Follow the Protocol section verbatim.',
    '',
    '    Every AskUserQuestion MUST include a "propose now" option so the',
    '    user can signal readiness at any turn.',
    '',
    '    When writing output_path, emit either:',
    '      - a JSON array of slice objects, or',
    '      - a JSON object `{ "steps": [...], "_order": [...] }`.',
    '    Then list output_path under `files_modified:` and emit',
    '    AGENT_COMPLETE.',
    `  description: "design modify: ${describeTarget(args.target)}"`,
    '',
    `After the Agent tool returns, report: ewh report --run ${args.runId} --step 0 --result ${args.proposedPath}`,
  ].join('\n');
  return {
    kind: 'tool-call',
    body,
    report_with: `ewh report --run ${args.runId} --step 0 --result ${args.proposedPath}`,
  };
}

async function continueModifyFerry(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'modify_ferry' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind !== 'result') {
    throw new Error(
      `design modify ferry: unexpected report kind '${report.kind}' (expected 'result')`,
    );
  }
  if (!report.result_path) {
    throw new Error(`design modify ferry: expected --result <proposed.json>`);
  }
  // For non-workflow targets (agent/rule edits), skip diff and go straight
  // to an approval gate showing the proposed body. MVP for this session:
  // only workflow-step / workflow targets run through the structural diff.
  if (!sub.contract_path || !sub.workflow_name) {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: [
        `ewh design modify: wrote proposed.json to ${sub.proposed_path}.`,
        '',
        'Agent/rule modifications are not yet auto-applied by the binary —',
        'inspect the proposed file and apply edits manually, or re-run',
        'through `design` if the asset must change shape.',
      ].join('\n'),
    };
  }

  const current = await loadContract(sub.contract_path);
  let diff: DiffResult;
  let integrity: string[];
  try {
    const raw = await fs.readFile(sub.proposed_path, 'utf8');
    const parsed = parseProposedInput(JSON.parse(raw));
    diff = diffContract(current, parsed);
    integrity = await checkIntegrity(diff.merged, {
      projectRoot: opts.projectRoot,
      pluginRoot: opts.pluginRoot,
    });
  } catch (err) {
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `ewh design modify: proposed.json invalid: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const summary = renderDiffSummary(diff, integrity);
  const hasErrors = diff.errors.length > 0 || integrity.length > 0;

  const lines: string[] = [];
  lines.push(`EWH design modify — review (${describeTarget(sub.target)})`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  if (hasErrors) {
    lines.push('The proposal has issues listed above.');
    lines.push('Approving will write the merged JSON even with these gaps.');
    lines.push('Consider rejecting so the outer-session LLM can iterate.');
    lines.push('');
  }
  lines.push('On approve: atomically update');
  lines.push(`  - ${sub.contract_path}`);
  lines.push(
    `  - ${join('.claude', 'ewh-workflows', `${sub.workflow_name}.md`)}`,
  );
  lines.push('On reject: discard proposed.json and re-run the ferry.');
  lines.push('');
  lines.push('Choose:');
  lines.push(`  approve: ewh report --run ${run.run_id} --step 0 --decision yes`);
  lines.push(`  reject:  ewh report --run ${run.run_id} --step 0 --decision no`);

  const reviewState: SubcommandState = {
    kind: 'design',
    phase: 'modify_review',
    target: sub.target,
    run_root: sub.run_root,
    context_path: sub.context_path,
    proposed_path: sub.proposed_path,
    contract_path: sub.contract_path,
    workflow_name: sub.workflow_name,
  };
  run.subcommand_state = reviewState;
  return {
    kind: 'user-prompt',
    body: lines.join('\n'),
    report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
  };
}

async function continueModifyReview(
  run: RunState,
  sub: Extract<SubcommandState, { kind: 'design'; phase: 'modify_review' }>,
  report: Report,
  opts: DesignContinueOptions,
): Promise<Instruction> {
  if (report.kind !== 'decision') {
    throw new Error(
      `design modify review: unexpected report kind '${report.kind}'`,
    );
  }
  if (report.decision === 'no') {
    // Discard proposed.json and re-ferry. Context package stays — it was
    // built once up front and doesn't depend on the previous proposal.
    try {
      await fs.unlink(sub.proposed_path);
    } catch {
      // already gone
    }
    const ferryState: SubcommandState = {
      kind: 'design',
      phase: 'modify_ferry',
      target: sub.target,
      run_root: sub.run_root,
      context_path: sub.context_path,
      proposed_path: sub.proposed_path,
      contract_path: sub.contract_path,
      workflow_name: sub.workflow_name,
    };
    run.subcommand_state = ferryState;
    return buildModifyFerryInstruction({
      runId: run.run_id,
      target: sub.target,
      contextPath: sub.context_path,
      proposedPath: sub.proposed_path,
    });
  }

  // approve → atomic commit.
  if (!sub.contract_path || !sub.workflow_name) {
    throw new Error(
      'design modify review: approve path requires contract_path and workflow_name',
    );
  }
  const current = await loadContract(sub.contract_path);
  const raw = await fs.readFile(sub.proposed_path, 'utf8');
  const parsed = parseProposedInput(JSON.parse(raw));
  const diff = diffContract(current, parsed);

  const mdPath = join(
    opts.projectRoot,
    '.claude',
    'ewh-workflows',
    `${sub.workflow_name}.md`,
  );
  const mdBody = renderWorkflowMd(diff.merged);

  // Atomic JSON write first — if it crashes, the old contract is untouched
  // (atomicWrite is tmp+fsync+rename). The md re-render is a derived
  // artifact; even if the process crashes between the two writes, rerunning
  // `design modify` or `manage` will regenerate md from JSON.
  await atomicWrite(
    sub.contract_path,
    JSON.stringify(diff.merged, null, 2) + '\n',
  );
  await atomicWrite(mdPath, mdBody);

  run.subcommand_state = undefined;
  const body = [
    `Applied design modify to '${sub.workflow_name}':`,
    renderDiffSummary(diff, []),
    '',
    `Wrote:`,
    `  ~ ${sub.contract_path}`,
    `  ~ ${mdPath}`,
  ].join('\n');
  return { kind: 'done', body };
}

async function atomicWrite(dst: string, body: string): Promise<void> {
  await fs.mkdir(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dst);
}

/**
 * Minimal agent stub body. Marked clearly as a starting point. The
 * AGENT_COMPLETE sentinel is mandatory per the EWH contract.
 */
export function renderAgentStub(agentName: string, stepDescription: string): string {
  const fm = [
    '---',
    `name: ${agentName}`,
    `description: Generated stub for '${agentName}' — edit this file to describe what the agent should do.`,
    'model: sonnet',
    'tools: [Read, Write]',
    'default_rules: []',
    '---',
    '',
  ].join('\n');
  const trimmed = stepDescription.trim();
  const body = [
    `# ${agentName} (stub)`,
    '',
    'This agent was auto-generated by `/ewh:doit design` as a starting point.',
    'Replace this body with the agent\'s actual instructions.',
    '',
    '## Task',
    '',
    trimmed.length > 0 ? trimmed : '(describe what this agent does here)',
    '',
    '## Before You Start',
    '',
    '- Verify the required context is present; if not, bail out by emitting `AGENT_COMPLETE` early.',
    '',
    '## Output format',
    '',
    'After completing your task, emit exactly `AGENT_COMPLETE` as the last line.',
    '',
  ].join('\n');
  return fm + body;
}
