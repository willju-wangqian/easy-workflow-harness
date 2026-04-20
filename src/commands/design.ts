/**
 * `ewh design "<description>"` — conversational interview to propose one or
 * more EWH artifacts (workflows, agents, rules), then a shape gate, per-file
 * authoring + gates, and finally atomic writes.
 *
 * Session 2 scope: `interview` and `shape_gate` phases. Later phases
 * (`author`, `file_gate`, `refine`, `write`) are stubbed — each emits a
 * placeholder `done` so the flow doesn't crash if reached.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import { runDir } from '../state/store.js';
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
    case 'file_gate':
    case 'refine':
    case 'write':
      run.subcommand_state = undefined;
      return {
        kind: 'done',
        body: `ewh design: phase '${sub.phase}' not yet implemented (session 2 MVP).`,
      };
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

  run.subcommand_state = {
    kind: 'design',
    phase: 'shape_gate',
    proposal_path: report.result_path,
  };
  return renderShapeGate(run, parsed.proposal, paths);
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
  // approve = decision yes, reject = decision no, edit = result (instruction file)
  if (report.kind === 'decision') {
    if (report.decision === 'yes') {
      run.subcommand_state = {
        kind: 'design',
        phase: 'author',
        proposal_path: sub.proposal_path,
        author_index: 0,
      };
      return {
        kind: 'done',
        body: [
          "ewh design: proposal approved — author phase not yet implemented (session 2 MVP).",
          `Staged proposal: ${sub.proposal_path}`,
        ].join('\n'),
      };
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
): Instruction {
  const editPath = paths.edit;
  const lines: string[] = [];
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
