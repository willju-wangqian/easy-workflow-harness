import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  startDesign,
  continueDesign,
  validateShape,
  designPaths,
  type ShapeProposal,
} from '../src/commands/design.js';
import type { CatalogEntry } from '../src/commands/design-catalog.js';
import type { Report, RunState, SubcommandState } from '../src/state/types.js';

let tmpDir: string;
let projectRoot: string;
let pluginRoot: string;

const RUN_ID = 'testrun';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-design-test-'));
  projectRoot = join(tmpDir, 'project');
  pluginRoot = join(tmpDir, 'plugin');
  for (const dir of [
    join(pluginRoot, 'workflows'),
    join(pluginRoot, 'agents'),
    join(pluginRoot, 'rules'),
    join(projectRoot, '.claude', 'workflows'),
    join(projectRoot, '.claude', 'agents'),
    join(projectRoot, '.claude', 'rules'),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(state: SubcommandState): RunState {
  return {
    run_id: RUN_ID,
    workflow: 'design',
    raw_argv: 'design "test"',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: 'design',
    subcommand_state: state,
  };
}

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n## Body\n`;
}

async function seedCatalog(): Promise<void> {
  await fs.writeFile(
    join(pluginRoot, 'agents', 'coder.md'),
    frontmatter({ name: 'coder', description: 'Writes code' }),
  );
  await fs.writeFile(
    join(pluginRoot, 'workflows', 'add-feature.md'),
    frontmatter({ name: 'add-feature', description: 'Ship a feature' }),
  );
  await fs.writeFile(
    join(pluginRoot, 'rules', 'style.md'),
    frontmatter({ name: 'style', description: 'Style rules' }),
  );
}

function makeProposal(artifacts: ShapeProposal['artifacts']): ShapeProposal {
  return {
    description: 'test proposal',
    artifacts,
  };
}

async function writeShape(paths: ReturnType<typeof designPaths>, proposal: ShapeProposal): Promise<string> {
  await fs.mkdir(paths.proposedDir, { recursive: true });
  await fs.writeFile(paths.shape, JSON.stringify(proposal, null, 2), 'utf8');
  return paths.shape;
}

describe('validateShape', () => {
  const catalog: CatalogEntry[] = [
    { type: 'agent', name: 'coder', path: 'agents/coder.md', scope: 'plugin', description: '' },
    { type: 'workflow', name: 'add-feature', path: 'workflows/add-feature.md', scope: 'plugin', description: '' },
    { type: 'rule', name: 'style', path: 'rules/style.md', scope: 'plugin', description: '' },
  ];

  it('accepts a valid proposal with creates + updates + deps', () => {
    const prop = makeProposal([
      {
        type: 'rule',
        op: 'create',
        name: 'no-magic-numbers',
        scope: 'project',
        path: 'rules/no-magic-numbers.md',
        description: '',
        frontmatter: { name: 'no-magic-numbers' },
      },
      {
        type: 'agent',
        op: 'update',
        name: 'coder',
        scope: 'plugin',
        path: 'agents/coder.md',
        description: '',
        frontmatter: { name: 'coder' },
        depends_on: ['no-magic-numbers', 'style'],
      },
    ]);
    expect(validateShape(prop, catalog)).toEqual([]);
  });

  it('rejects op:update whose path is missing from the catalog', () => {
    const prop = makeProposal([
      {
        type: 'agent',
        op: 'update',
        name: 'ghost',
        scope: 'plugin',
        path: 'agents/ghost.md',
        description: '',
        frontmatter: { name: 'ghost' },
      },
    ]);
    const errs = validateShape(prop, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/op:update but target.*not in the catalog/);
  });

  it('rejects op:create whose path already exists in the catalog', () => {
    const prop = makeProposal([
      {
        type: 'agent',
        op: 'create',
        name: 'coder',
        scope: 'plugin',
        path: 'agents/coder.md',
        description: '',
        frontmatter: { name: 'coder' },
      },
    ]);
    const errs = validateShape(prop, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/op:create but target.*already exists/);
  });

  it('rejects depends_on that resolves to neither batch nor catalog', () => {
    const prop = makeProposal([
      {
        type: 'agent',
        op: 'update',
        name: 'coder',
        scope: 'plugin',
        path: 'agents/coder.md',
        description: '',
        frontmatter: { name: 'coder' },
        depends_on: ['nonexistent'],
      },
    ]);
    const errs = validateShape(prop, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/depends_on 'nonexistent'/);
  });
});

describe('startDesign', () => {
  it('emits done when description is empty', async () => {
    const r = await startDesign({ projectRoot, pluginRoot, runId: RUN_ID, description: '  ' });
    expect(r.state).toBeUndefined();
    expect(r.instruction.kind).toBe('done');
    expect(r.instruction.body).toMatch(/missing description/);
  });

  it('writes catalog + description, emits facilitator tool-call, state=interview', async () => {
    await seedCatalog();
    const r = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'Add a rate-limiting rule',
    });
    expect(r.instruction.kind).toBe('tool-call');
    expect(r.instruction.body).toMatch(/subagent_type: ewh:design-facilitator/);
    expect(r.instruction.body).toMatch(/catalog_path:/);
    expect(r.instruction.body).toMatch(/description_path:/);
    expect(r.instruction.body).toMatch(/output_path:/);

    expect(r.state).toMatchObject({ kind: 'design', phase: 'interview' });
    const paths = designPaths(projectRoot, RUN_ID);
    const catalog = JSON.parse(await fs.readFile(paths.catalog, 'utf8')) as CatalogEntry[];
    expect(catalog.length).toBe(3);
    const desc = await fs.readFile(paths.description, 'utf8');
    expect(desc).toMatch(/rate-limiting/);
  });
});

describe('continueDesign — interview phase', () => {
  it('valid shape.json transitions to shape_gate and emits user-prompt', async () => {
    await seedCatalog();
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'add rule',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    const proposal = makeProposal([
      {
        type: 'rule',
        op: 'create',
        name: 'no-magic-numbers',
        scope: 'project',
        path: 'rules/no-magic-numbers.md',
        description: 'forbid literal magic numbers',
        frontmatter: { name: 'no-magic-numbers', description: 'forbid literal magic numbers' },
      },
    ]);
    const shapePath = await writeShape(paths, proposal);
    const run = makeRun(start.state!);

    const report: Report = { kind: 'result', step_index: 0, result_path: shapePath };
    const instr = await continueDesign(run, report, { projectRoot, pluginRoot });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/shape gate/);
    expect(instr.body).toMatch(/no-magic-numbers/);
    expect(run.subcommand_state).toMatchObject({
      kind: 'design',
      phase: 'shape_gate',
      proposal_path: shapePath,
    });
  });

  it('invalid shape.json bounces back to interview and re-spawns facilitator', async () => {
    await seedCatalog();
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'add rule',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    // update target that isn't in the catalog
    const badProposal = makeProposal([
      {
        type: 'agent',
        op: 'update',
        name: 'ghost',
        scope: 'plugin',
        path: 'agents/ghost.md',
        description: '',
        frontmatter: { name: 'ghost' },
      },
    ]);
    const shapePath = await writeShape(paths, badProposal);
    const run = makeRun(start.state!);

    const report: Report = { kind: 'result', step_index: 0, result_path: shapePath };
    const instr = await continueDesign(run, report, { projectRoot, pluginRoot });

    expect(instr.kind).toBe('tool-call');
    expect(instr.body).toMatch(/subagent_type: ewh:design-facilitator/);
    expect(run.subcommand_state).toMatchObject({ kind: 'design', phase: 'interview' });
    const descContent = await fs.readFile(paths.description, 'utf8');
    expect(descContent).toMatch(/validation errors/);
    expect(descContent).toMatch(/agents\/ghost\.md/);
  });

  it('malformed JSON bounces back with an error note', async () => {
    await seedCatalog();
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'add rule',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    await fs.mkdir(paths.proposedDir, { recursive: true });
    await fs.writeFile(paths.shape, '{ not valid json', 'utf8');
    const run = makeRun(start.state!);

    const report: Report = { kind: 'result', step_index: 0, result_path: paths.shape };
    const instr = await continueDesign(run, report, { projectRoot, pluginRoot });

    expect(instr.kind).toBe('tool-call');
    expect(run.subcommand_state).toMatchObject({ kind: 'design', phase: 'interview' });
    const descContent = await fs.readFile(paths.description, 'utf8');
    expect(descContent).toMatch(/not valid JSON/);
  });
});

describe('continueDesign — shape_gate phase', () => {
  async function setupShapeGate(): Promise<{ run: RunState; shapePath: string }> {
    await seedCatalog();
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'add rule',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    const proposal = makeProposal([
      {
        type: 'rule',
        op: 'create',
        name: 'no-magic-numbers',
        scope: 'project',
        path: 'rules/no-magic-numbers.md',
        description: '',
        frontmatter: { name: 'no-magic-numbers' },
      },
    ]);
    const shapePath = await writeShape(paths, proposal);
    const run = makeRun(start.state!);
    // drive into shape_gate by reporting the shape
    await continueDesign(run, { kind: 'result', step_index: 0, result_path: shapePath }, {
      projectRoot,
      pluginRoot,
    });
    expect(run.subcommand_state).toMatchObject({ phase: 'shape_gate' });
    return { run, shapePath };
  }

  it('approve (decision yes) transitions to author phase', async () => {
    const { run, shapePath } = await setupShapeGate();
    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({
      kind: 'design',
      phase: 'author',
      proposal_path: shapePath,
      author_index: 0,
    });
    // Session 2 stub: approve emits a placeholder done for now
    expect(instr.kind).toBe('done');
  });

  it('reject (decision no) clears state and emits done', async () => {
    const { run } = await setupShapeGate();
    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    expect(instr.kind).toBe('done');
    expect(instr.body).toMatch(/rejected/i);
    expect(run.subcommand_state).toBeUndefined();
  });

  it('edit (result with instruction path) bounces back to interview with appended note', async () => {
    const { run } = await setupShapeGate();
    const paths = designPaths(projectRoot, RUN_ID);
    const editPath = join(paths.runRoot, 'shape-edit.txt');
    await fs.writeFile(editPath, 'please also add an agent for validation', 'utf8');

    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: editPath },
      { projectRoot, pluginRoot },
    );
    expect(instr.kind).toBe('tool-call');
    expect(run.subcommand_state).toMatchObject({ kind: 'design', phase: 'interview' });
    const descContent = await fs.readFile(paths.description, 'utf8');
    expect(descContent).toMatch(/user edit instruction/);
    expect(descContent).toMatch(/agent for validation/);
  });
});
