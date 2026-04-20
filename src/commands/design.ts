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
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import { runDir, writeRunState } from '../state/store.js';
import { buildCatalog, type CatalogEntry } from './design-catalog.js';

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
