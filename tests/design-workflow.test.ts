import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  startDesign,
  continueDesign,
  designPaths,
  isWorkflowName,
  readWorkflowShape,
  validateWorkflowDraft,
  draftToContract,
  renderAgentStub,
  type WorkflowDraft,
} from '../src/commands/design.js';
import { loadContract } from '../src/workflow/contract-loader.js';
import { renderWorkflowMd } from '../src/workflow/render-md.js';
import type { Report, RunState, SubcommandState } from '../src/state/types.js';

let tmpDir: string;
let projectRoot: string;
let pluginRoot: string;

const RUN_ID = 'testrun';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-design-wf-test-'));
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
    raw_argv: 'design test-wf',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: 'design',
    subcommand_state: state,
  };
}

async function writeWorkflowShape(path: string, draft: WorkflowDraft): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(draft, null, 2), 'utf8');
}

describe('isWorkflowName', () => {
  it('accepts bare kebab/snake identifiers', () => {
    expect(isWorkflowName('add-feature')).toBe(true);
    expect(isWorkflowName('my_workflow')).toBe(true);
    expect(isWorkflowName('wf42')).toBe(true);
  });
  it('rejects prose descriptions', () => {
    expect(isWorkflowName('add a rate limiter')).toBe(false);
    expect(isWorkflowName('Design WF')).toBe(false);
    expect(isWorkflowName('a')).toBe(false); // too short
    expect(isWorkflowName('')).toBe(false);
  });
});

describe('validateWorkflowDraft', () => {
  it('accepts a well-formed draft', () => {
    const r = validateWorkflowDraft({
      name: 'x',
      description: 'y',
      steps: [{ name: 's1', agent: 'a1', description: 'd1' }],
    });
    expect(r.ok).toBe(true);
  });
  it('rejects missing required fields', () => {
    expect(validateWorkflowDraft({ description: 'y', steps: [] }).ok).toBe(false);
    expect(validateWorkflowDraft({ name: 'x', steps: [] }).ok).toBe(false);
    expect(validateWorkflowDraft({ name: 'x', description: 'y' }).ok).toBe(false);
  });
  it('rejects duplicate step names', () => {
    const r = validateWorkflowDraft({
      name: 'x',
      description: 'y',
      steps: [
        { name: 'dup', agent: 'a', description: 'd' },
        { name: 'dup', agent: 'a', description: 'd' },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe('draftToContract', () => {
  it('fills runtime fields with safe defaults', () => {
    const contract = draftToContract({
      name: 'x',
      description: 'y',
      steps: [{ name: 's', agent: 'a', description: 'd' }],
    });
    expect(contract.steps[0]).toEqual({
      name: 's',
      agent: 'a',
      description: 'd',
      gate: 'structural',
      produces: [],
      context: [],
      requires: [],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    });
  });
});

describe('startDesign (workflow mode)', () => {
  it('routes kebab-case description into design_workflow_interview', async () => {
    const r = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'test-wf',
    });
    expect(r.state).toMatchObject({
      kind: 'design',
      phase: 'design_workflow_interview',
      workflow_name: 'test-wf',
    });
    expect(r.instruction.kind).toBe('tool-call');
    expect(r.instruction.body).toMatch(/workflow-creation mode/);
    expect(r.instruction.body).toMatch(/workflow_name:\s+test-wf/);
  });

  it('prose description stays in the existing facilitator flow', async () => {
    const r = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'design a rate limiter rule',
    });
    expect(r.state).toMatchObject({ kind: 'design', phase: 'interview' });
  });
});

describe('continueDesign — design_workflow_interview', () => {
  it('valid shape + no template → transitions to design_workflow_gate', async () => {
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'test-wf',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    const draft: WorkflowDraft = {
      name: 'test-wf',
      description: 'A test workflow',
      steps: [
        { name: 'plan', agent: 'planner', description: 'design the feature' },
        { name: 'code', agent: 'custom-coder', description: 'implement the plan' },
      ],
    };
    await writeWorkflowShape(paths.workflowShape, draft);

    const run = makeRun(start.state!);
    const report: Report = {
      kind: 'result',
      step_index: 0,
      result_path: paths.workflowShape,
    };
    const instr = await continueDesign(run, report, { projectRoot, pluginRoot });

    expect(run.subcommand_state).toMatchObject({
      kind: 'design',
      phase: 'design_workflow_gate',
      workflow_name: 'test-wf',
    });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/workflow gate/);
    expect(instr.body).toMatch(/plan.*planner/);
  });

  it('plugin template with same name triggers template_gate', async () => {
    // Plugin ships a workflow with the same name
    await fs.writeFile(
      join(pluginRoot, 'workflows', 'test-wf.md'),
      [
        '---',
        'name: test-wf',
        'description: Template from plugin',
        '---',
        '',
        '## Steps',
        '',
        '- name: plan',
        '  agent: planner',
        '  gate: structural',
        '  description: plan something',
        '',
        '- name: code',
        '  agent: coder',
        '  gate: structural',
        '  description: code something',
        '',
      ].join('\n'),
      'utf8',
    );

    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'test-wf',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    await writeWorkflowShape(paths.workflowShape, {
      name: 'test-wf',
      description: 'user draft',
      steps: [{ name: 'just-one', agent: 'a', description: 'd' }],
    });

    const run = makeRun(start.state!);
    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: paths.workflowShape },
      { projectRoot, pluginRoot },
    );

    expect(run.subcommand_state).toMatchObject({
      kind: 'design',
      phase: 'design_workflow_template_gate',
      workflow_name: 'test-wf',
    });
    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/template gate/);
    expect(instr.body).toMatch(/plugin template exists at/);
  });

  it('invalid shape bounces back to interview with error note', async () => {
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'test-wf',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    await fs.mkdir(paths.proposedDir, { recursive: true });
    await fs.writeFile(paths.workflowShape, '{ not valid json', 'utf8');

    const run = makeRun(start.state!);
    const instr = await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: paths.workflowShape },
      { projectRoot, pluginRoot },
    );

    expect(run.subcommand_state).toMatchObject({
      kind: 'design',
      phase: 'design_workflow_interview',
    });
    expect(instr.kind).toBe('tool-call');
    const desc = await fs.readFile(paths.description, 'utf8');
    expect(desc).toMatch(/validation errors/);
  });
});

describe('continueDesign — design_workflow_template_gate', () => {
  async function setupTemplate(): Promise<{ run: RunState; paths: ReturnType<typeof designPaths> }> {
    await fs.writeFile(
      join(pluginRoot, 'workflows', 'test-wf.md'),
      [
        '---',
        'name: test-wf',
        'description: Template from plugin',
        '---',
        '',
        '## Steps',
        '',
        '- name: plan',
        '  agent: planner',
        '  gate: structural',
        '  description: plan via template',
        '',
        '- name: code',
        '  agent: coder',
        '  gate: structural',
        '  description: implement via template',
        '',
      ].join('\n'),
      'utf8',
    );
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: 'test-wf',
    });
    const paths = designPaths(projectRoot, RUN_ID);
    await writeWorkflowShape(paths.workflowShape, {
      name: 'test-wf',
      description: 'user draft',
      steps: [{ name: 'draft', agent: 'drafter', description: 'whatever' }],
    });

    const run = makeRun(start.state!);
    await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: paths.workflowShape },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'design_workflow_template_gate' });
    return { run, paths };
  }

  it('yes overwrites shape with template-derived draft', async () => {
    const { run, paths } = await setupTemplate();
    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'design_workflow_gate' });
    expect(instr.kind).toBe('user-prompt');
    // Shape path now holds the template's steps
    const saved = await readWorkflowShape(paths.workflowShape);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.draft.steps.map((s) => s.name)).toEqual(['plan', 'code']);
      expect(saved.draft.steps.map((s) => s.agent)).toEqual(['planner', 'coder']);
    }
  });

  it('no keeps the user draft', async () => {
    const { run, paths } = await setupTemplate();
    await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'design_workflow_gate' });
    const saved = await readWorkflowShape(paths.workflowShape);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.draft.steps.map((s) => s.name)).toEqual(['draft']);
  });
});

describe('continueDesign — design_workflow_write', () => {
  async function driveToGate(draft: WorkflowDraft): Promise<{ run: RunState }> {
    const start = await startDesign({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      description: draft.name,
    });
    const paths = designPaths(projectRoot, RUN_ID);
    await writeWorkflowShape(paths.workflowShape, draft);
    const run = makeRun(start.state!);
    await continueDesign(
      run,
      { kind: 'result', step_index: 0, result_path: paths.workflowShape },
      { projectRoot, pluginRoot },
    );
    expect(run.subcommand_state).toMatchObject({ phase: 'design_workflow_gate' });
    return { run };
  }

  it('approve: writes workflow.json, workflow.md, and missing agent stubs atomically', async () => {
    // Plugin ships 'planner' so no stub needed; 'custom-coder' is a new agent
    await fs.writeFile(
      join(pluginRoot, 'agents', 'planner.md'),
      '---\nname: planner\n---\n\n## Body\n',
      'utf8',
    );

    const draft: WorkflowDraft = {
      name: 'test-wf',
      description: 'Test workflow for session 3',
      steps: [
        { name: 'plan', agent: 'planner', description: 'plan the feature' },
        { name: 'code', agent: 'custom-coder', description: 'implement it' },
      ],
    };
    const { run } = await driveToGate(draft);
    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );

    expect(instr.kind).toBe('done');
    expect(run.subcommand_state).toBeUndefined();

    // workflow.json parses as a WorkflowContract
    const jsonPath = join(projectRoot, '.claude', 'ewh-workflows', 'test-wf.json');
    const contract = await loadContract(jsonPath);
    expect(contract.name).toBe('test-wf');
    expect(contract.steps.map((s) => s.name)).toEqual(['plan', 'code']);
    expect(contract.steps[0]!.gate).toBe('structural');
    expect(contract.steps[0]!.produces).toEqual([]);

    // workflow.md parses back to the same shape (round-trip via renderer)
    const mdPath = join(projectRoot, '.claude', 'ewh-workflows', 'test-wf.md');
    const mdBody = await fs.readFile(mdPath, 'utf8');
    expect(mdBody).toBe(renderWorkflowMd(contract));

    // Stub created only for the unknown agent
    const plannerStub = join(projectRoot, '.claude', 'agents', 'planner.md');
    const coderStub = join(projectRoot, '.claude', 'agents', 'custom-coder.md');
    await expect(fs.access(plannerStub)).rejects.toThrow();
    const stubBody = await fs.readFile(coderStub, 'utf8');
    expect(stubBody).toMatch(/name: custom-coder/);
    expect(stubBody).toMatch(/default_rules: \[\]/);
    expect(stubBody).toMatch(/AGENT_COMPLETE/);
    expect(stubBody).toMatch(/implement it/);
  });

  it('reject at gate leaves no files behind', async () => {
    const draft: WorkflowDraft = {
      name: 'skipwf',
      description: '',
      steps: [{ name: 's1', agent: 'a1', description: 'd' }],
    };
    const { run } = await driveToGate(draft);
    const instr = await continueDesign(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    expect(instr.kind).toBe('done');
    expect(instr.body).toMatch(/rejected/i);
    await expect(
      fs.access(join(projectRoot, '.claude', 'ewh-workflows', 'skipwf.json')),
    ).rejects.toThrow();
  });

  it('re-run after partial-delete: all files reappear', async () => {
    const draft: WorkflowDraft = {
      name: 'redowf',
      description: 'd',
      steps: [{ name: 's1', agent: 'agentless', description: 'x' }],
    };

    // First run
    {
      const { run } = await driveToGate(draft);
      await continueDesign(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }
    const jsonPath = join(projectRoot, '.claude', 'ewh-workflows', 'redowf.json');
    const mdPath = join(projectRoot, '.claude', 'ewh-workflows', 'redowf.md');
    const stubPath = join(projectRoot, '.claude', 'agents', 'agentless.md');
    await expect(fs.access(jsonPath)).resolves.toBeUndefined();

    // Delete the .md and re-run (fresh run id)
    await fs.unlink(mdPath);

    const r2 = await startDesign({
      projectRoot,
      pluginRoot,
      runId: 'testrun2',
      description: 'redowf',
    });
    const paths2 = designPaths(projectRoot, 'testrun2');
    await writeWorkflowShape(paths2.workflowShape, draft);
    const run2: RunState = {
      ...makeRun(r2.state!),
      run_id: 'testrun2',
    };
    await continueDesign(
      run2,
      { kind: 'result', step_index: 0, result_path: paths2.workflowShape },
      { projectRoot, pluginRoot },
    );
    await continueDesign(
      run2,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );

    await expect(fs.access(jsonPath)).resolves.toBeUndefined();
    await expect(fs.access(mdPath)).resolves.toBeUndefined();
    await expect(fs.access(stubPath)).resolves.toBeUndefined();
  });
});

describe('renderAgentStub', () => {
  it('has required frontmatter and AGENT_COMPLETE sentinel', () => {
    const stub = renderAgentStub('foo', 'do the thing');
    expect(stub).toMatch(/^---\nname: foo/);
    expect(stub).toMatch(/model: sonnet/);
    expect(stub).toMatch(/tools: \[Read, Write\]/);
    expect(stub).toMatch(/default_rules: \[\]/);
    expect(stub).toMatch(/do the thing/);
    expect(stub).toMatch(/AGENT_COMPLETE/);
  });
});

describe('round-trip: draftToContract → renderWorkflowMd → loadContract', () => {
  it('preserves name/description/steps through the write path', async () => {
    const draft: WorkflowDraft = {
      name: 'round-wf',
      description: 'check roundtrip',
      steps: [
        { name: 'plan', agent: 'planner', description: 'plan it' },
        { name: 'code', agent: 'coder', description: 'code it' },
      ],
    };
    const contract = draftToContract(draft);
    // JSON → rendered md is deterministic
    expect(renderWorkflowMd(contract)).toBe(renderWorkflowMd(contract));

    // Write JSON to disk and load through the real loader
    const jsonPath = join(tmpDir, 'round-wf.json');
    await fs.writeFile(jsonPath, JSON.stringify(contract, null, 2), 'utf8');
    const reloaded = await loadContract(jsonPath);
    expect(reloaded).toEqual(contract);
  });
});
