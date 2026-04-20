import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  startDesign,
  continueDesign,
  validateShape,
  designPaths,
  stagedPathForArtifact,
  isInsidePluginRepo,
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

  it('approve (decision yes) transitions to author phase and emits first author tool-call', async () => {
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
    expect(instr.kind).toBe('tool-call');
    expect(instr.body).toMatch(/subagent_type: ewh:artifact-author/);
    expect(instr.body).toMatch(/no-magic-numbers/);
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

// ── Helpers for session 3 tests ───────────────────────────────────────────

function makeArtifact(i: number): ShapeProposal['artifacts'][number] {
  return {
    type: 'rule',
    op: 'create',
    name: `rule-${i}`,
    scope: 'project',
    path: `rules/rule-${i}.md`,
    description: `rule ${i}`,
    frontmatter: { name: `rule-${i}` },
  };
}

async function writeAllStagedFiles(
  paths: ReturnType<typeof designPaths>,
  artifacts: ShapeProposal['artifacts'],
): Promise<void> {
  await fs.mkdir(paths.proposedDir, { recursive: true });
  for (const a of artifacts) {
    const sp = stagedPathForArtifact(paths.proposedDir, a);
    await fs.writeFile(sp, `---\nname: ${a.name}\n---\n\n## Body\n`, 'utf8');
  }
}

// ── author phase ──────────────────────────────────────────────────────────

describe('continueDesign — author phase', () => {
  it('drives through 3 author reports, state ends at file_gate with file_index 0', async () => {
    const artifacts = [makeArtifact(0), makeArtifact(1), makeArtifact(2)];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, artifacts);

    const run = makeRun({
      kind: 'design',
      phase: 'author',
      proposal_path: shapePath,
      author_index: 0,
    });

    // Report 1st author done
    let instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: stagedPathForArtifact(paths.proposedDir, artifacts[0]!) },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'author', author_index: 1 });
    expect(instr.kind).toBe('tool-call');
    expect(instr.body).toMatch(/artifact-author/);

    // Report 2nd author done
    instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: stagedPathForArtifact(paths.proposedDir, artifacts[1]!) },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'author', author_index: 2 });
    expect(instr.kind).toBe('tool-call');

    // Report 3rd author done → transitions to file_gate
    instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: stagedPathForArtifact(paths.proposedDir, artifacts[2]!) },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'file_gate', file_index: 0 });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/file gate/i);
    expect(instr.body).toMatch(/rule-0/);
  });
});

// ── file_gate phase ───────────────────────────────────────────────────────

describe('continueDesign — file_gate phase', () => {
  it('approve-advance: 2 files, approve first → file_index 1, approve second → write', async () => {
    const artifacts = [makeArtifact(0), makeArtifact(1)];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, artifacts);

    const run = makeRun({
      kind: 'design',
      phase: 'file_gate',
      proposal_path: shapePath,
      file_index: 0,
    });

    // Approve first file → advances to file_index 1
    let instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'file_gate', file_index: 1 });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/rule-1/);

    // Approve second file → write phase executes and completes
    instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toBeUndefined();
    expect(instr.kind).toBe('done');
    expect(instr.body).toContain('Wrote 2 artifacts');
  });

  it('reject: file 2 of 3 → done with rejection message, state cleared', async () => {
    const artifacts = [makeArtifact(0), makeArtifact(1), makeArtifact(2)];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);

    const run = makeRun({
      kind: 'design',
      phase: 'file_gate',
      proposal_path: shapePath,
      file_index: 1,
    });

    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    expect(instr.kind).toBe('done');
    expect(instr.body).toMatch(/Rejected file 2\/3/);
    expect(run.subcommand_state).toBeUndefined();
  });
});

// ── refine phase ──────────────────────────────────────────────────────────

describe('continueDesign — refine phase', () => {
  it('round trip: file_gate edit → refine state + refiner tool-call → back at file_gate with refined content', async () => {
    const artifact = makeArtifact(0);
    const proposal = makeProposal([artifact]);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, [artifact]);

    const run = makeRun({
      kind: 'design',
      phase: 'file_gate',
      proposal_path: shapePath,
      file_index: 0,
    });

    // Write the edit instruction and report --result
    const editPath = join(paths.runRoot, 'file-gate-0-edit.txt');
    await fs.writeFile(editPath, 'Add more details to the body', 'utf8');

    let instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: editPath },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({
      phase: 'refine',
      file_index: 0,
      instruction: 'Add more details to the body',
    });
    expect(instr.kind).toBe('tool-call');
    expect(instr.body).toMatch(/artifact-refiner/);
    expect(instr.body).toMatch(/Add more details/);

    // Simulate refiner writing a revised file
    const stagedPath = stagedPathForArtifact(paths.proposedDir, artifact);
    await fs.writeFile(stagedPath, '---\nname: rule-0\n---\n\n## Body\n\nMore details here.\n', 'utf8');

    // Report refiner done → back at file_gate with same file_index
    instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: stagedPath },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'file_gate', file_index: 0 });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/file gate/i);
    expect(instr.body).toMatch(/More details here/);
  });
});

// ── scope validation ──────────────────────────────────────────────────────

describe('scope validation', () => {
  it('non-plugin project: rewrites scope:plugin → scope:project, gate body has note, shape.json mutated on disk', async () => {
    await seedCatalog();
    const start = await startDesign({ projectRoot, pluginRoot, runId: RUN_ID, description: 'add rule' });
    const paths = designPaths(projectRoot, RUN_ID);
    const proposal = makeProposal([
      {
        type: 'rule',
        op: 'create',
        name: 'my-rule',
        scope: 'plugin',
        path: 'rules/my-rule.md',
        description: '',
        frontmatter: { name: 'my-rule' },
      },
    ]);
    const shapePath = await writeShape(paths, proposal);
    const run = makeRun(start.state!);

    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: shapePath },
      { projectRoot, pluginRoot },
    );

    // Shape gate should be emitted with the rewrite note
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toContain('Auto-rewrote 1');
    expect(instr.body).toContain('scope:plugin');

    // shape.json on disk must have scope:project
    const mutated = JSON.parse(await fs.readFile(shapePath, 'utf8')) as ShapeProposal;
    expect(mutated.artifacts[0]!.scope).toBe('project');
  });

  it('isInsidePluginRepo returns false when no package.json in projectRoot', async () => {
    expect(await isInsidePluginRepo(projectRoot)).toBe(false);
  });

  it('isInsidePluginRepo returns true when package.json has name=easy-workflow-harness', async () => {
    await fs.writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'easy-workflow-harness' }),
      'utf8',
    );
    expect(await isInsidePluginRepo(projectRoot)).toBe(true);
  });
});

// ── write phase ───────────────────────────────────────────────────────────

describe('continueDesign — write phase', () => {
  it('dependency-order: rule → agent → workflow regardless of proposal order', async () => {
    const artifacts: ShapeProposal['artifacts'] = [
      { type: 'workflow', op: 'create', name: 'my-wf',    scope: 'project', path: 'workflows/my-wf.md',    description: '', frontmatter: {} },
      { type: 'agent',    op: 'create', name: 'my-agent', scope: 'project', path: 'agents/my-agent.md',    description: '', frontmatter: {} },
      { type: 'rule',     op: 'create', name: 'my-rule',  scope: 'project', path: 'rules/my-rule.md',      description: '', frontmatter: {} },
    ];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, artifacts);

    const run = makeRun({ kind: 'design', phase: 'write', proposal_path: shapePath });
    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0 },
      { projectRoot, pluginRoot },
    );

    expect(instr.kind).toBe('done');
    const lines = instr.body.split('\n');
    const ruleIdx  = lines.findIndex((l) => l.includes('rules/'));
    const agentIdx = lines.findIndex((l) => l.includes('agents/'));
    const wfIdx    = lines.findIndex((l) => l.includes('workflows/'));
    expect(ruleIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(wfIdx);
  });

  it('crash-resume: skips paths already in written, writes only remaining', async () => {
    const artifacts = [makeArtifact(0), makeArtifact(1), makeArtifact(2)];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, artifacts);

    // Simulate: target0 was already written before the crash
    const target0 = join(projectRoot, '.claude', 'rules', 'rule-0.md');
    await fs.writeFile(target0, '---\nname: rule-0\n---\n\n## Body\n', 'utf8');

    const run = makeRun({
      kind: 'design',
      phase: 'write',
      proposal_path: shapePath,
      written: [target0],
    });
    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0 },
      { projectRoot, pluginRoot },
    );

    expect(instr.kind).toBe('done');
    expect(instr.body).toContain('Wrote 3 artifacts');

    // target1 and target2 must have been written
    const target1 = join(projectRoot, '.claude', 'rules', 'rule-1.md');
    const target2 = join(projectRoot, '.claude', 'rules', 'rule-2.md');
    await expect(fs.access(target1)).resolves.toBeUndefined();
    await expect(fs.access(target2)).resolves.toBeUndefined();

    // target0 content unchanged (was not re-written)
    expect(await fs.readFile(target0, 'utf8')).toBe('---\nname: rule-0\n---\n\n## Body\n');
  });

  it('write summary: + for creates, ~ for updates (with "(updated)" suffix)', async () => {
    const createArtifact: ShapeProposal['artifacts'][number] = {
      type: 'rule',  op: 'create', name: 'new-rule', scope: 'project',
      path: 'rules/new-rule.md', description: '', frontmatter: {},
    };
    const updateArtifact: ShapeProposal['artifacts'][number] = {
      type: 'agent', op: 'update', name: 'my-coder', scope: 'project',
      path: 'agents/my-coder.md', description: '', frontmatter: {},
    };
    const artifacts = [createArtifact, updateArtifact];
    const proposal = makeProposal(artifacts);
    const paths = designPaths(projectRoot, RUN_ID);
    const shapePath = await writeShape(paths, proposal);
    await writeAllStagedFiles(paths, artifacts);

    // op:update requires existing target
    const existingAgent = join(projectRoot, '.claude', 'agents', 'my-coder.md');
    await fs.writeFile(existingAgent, '---\nname: my-coder\n---\n\n## Body\n', 'utf8');

    const run = makeRun({ kind: 'design', phase: 'write', proposal_path: shapePath });
    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0 },
      { projectRoot, pluginRoot },
    );

    expect(instr.kind).toBe('done');
    expect(instr.body).toMatch(/\+\s+\.claude\/rules\/new-rule\.md/);
    expect(instr.body).toMatch(/~\s+\.claude\/agents\/my-coder\.md.*updated/);
  });
});
