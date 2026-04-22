import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  startManage,
  continueManage,
} from '../src/commands/manage.js';
import { loadContract } from '../src/workflow/contract-loader.js';
import { renderWorkflowMd } from '../src/workflow/render-md.js';
import type {
  ContractStep,
  WorkflowContract,
} from '../src/workflow/contract.js';
import type { Report, RunState, SubcommandState } from '../src/state/types.js';

const RUN_ID = 'mgrun';

let tmpDir: string;
let projectRoot: string;
let pluginRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-manage-test-'));
  projectRoot = join(tmpDir, 'project');
  pluginRoot = join(tmpDir, 'plugin');
  for (const dir of [
    join(pluginRoot, 'workflows'),
    join(pluginRoot, 'agents'),
    join(pluginRoot, 'rules'),
    join(projectRoot, '.claude', 'ewh-workflows'),
    join(projectRoot, '.claude', 'agents'),
    join(projectRoot, '.claude', 'rules'),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeStep(overrides: Partial<ContractStep> = {}): ContractStep {
  return {
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
    ...overrides,
  };
}

async function writeContract(
  name: string,
  steps: ContractStep[],
  description = 'desc',
): Promise<string> {
  const contract: WorkflowContract = { name, description, steps };
  const path = join(projectRoot, '.claude', 'ewh-workflows', `${name}.json`);
  await fs.writeFile(path, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  return path;
}

function makeRun(state: SubcommandState): RunState {
  return {
    run_id: RUN_ID,
    workflow: 'manage',
    raw_argv: `manage test`,
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: 'manage',
    subcommand_state: state,
  };
}

async function driveKeepAll(
  run: RunState,
  opts: { projectRoot: string; pluginRoot: string },
  numFields: number,
): Promise<void> {
  for (let i = 0; i < numFields; i++) {
    const report: Report = { kind: 'decision', step_index: 0, decision: 'yes' };
    await continueManage(run, report, opts);
  }
}

describe('startManage', () => {
  it('emits done when the workflow has no contract', async () => {
    const r = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'missing',
    });
    expect(r.state).toBeUndefined();
    expect(r.instruction.kind).toBe('done');
    expect(r.instruction.body).toMatch(/no contract found/);
  });

  it('emits done when workflow name is missing', async () => {
    const r = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: '',
    });
    expect(r.state).toBeUndefined();
    expect(r.instruction.kind).toBe('done');
    expect(r.instruction.body).toMatch(/missing workflow name/);
  });

  it('starts at step 0, field=context when contract loads', async () => {
    await writeContract('flow', [makeStep({ name: 'plan', agent: 'planner' })]);
    const r = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    expect(r.state).toMatchObject({
      kind: 'manage',
      phase: 'field',
      workflow_name: 'flow',
      step_index: 0,
      field: 'context',
    });
    expect(r.instruction.kind).toBe('user-prompt');
    expect(r.instruction.body).toMatch(/Step 1\/1.*plan/);
    expect(r.instruction.body).toMatch(/Field: context/);
  });
});

describe('default_rules pre-selection', () => {
  it('pre-checks agent.default_rules when context is empty', async () => {
    // Agent with default_rules: [coding]
    await fs.writeFile(
      join(projectRoot, '.claude', 'agents', 'planner.md'),
      [
        '---',
        'name: planner',
        'description: The planner.',
        'model: sonnet',
        'tools: [Read, Write]',
        'default_rules: [coding]',
        '---',
        '',
        '## Body',
        '',
        'AGENT_COMPLETE',
      ].join('\n'),
      'utf8',
    );
    // Rule present
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'coding.md'),
      '---\nname: coding\n---\n\nbody\n',
      'utf8',
    );
    // Also an unrelated rule
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'other.md'),
      '---\nname: other\n---\n\nbody\n',
      'utf8',
    );

    await writeContract('flow', [makeStep({ name: 'plan', agent: 'planner' })]);
    const r = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    expect(r.instruction.body).toMatch(/\[x\] coding/);
    expect(r.instruction.body).toMatch(/\[ \] other/);
    expect(r.instruction.body).toMatch(
      /Pre-selected rules from agent 'planner'\.default_rules: coding/,
    );
  });

  it('pre-selects current rule picks when context is already populated', async () => {
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'coding.md'),
      '---\nname: coding\n---\n',
      'utf8',
    );
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'testing.md'),
      '---\nname: testing\n---\n',
      'utf8',
    );
    await writeContract('flow', [
      makeStep({
        name: 'plan',
        agent: 'planner',
        context: [{ type: 'rule', ref: 'testing' }],
      }),
    ]);
    const r = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    expect(r.instruction.body).toMatch(/\[x\] testing/);
    expect(r.instruction.body).toMatch(/\[ \] coding/);
  });
});

describe('full flow — keep-all then commit', () => {
  it('walks all 7 fields of a single-step contract and writes JSON + md', async () => {
    await writeContract('flow', [
      makeStep({ name: 'plan', agent: 'planner', description: 'plan step' }),
    ]);

    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    expect(r0.state).toBeDefined();
    const run = makeRun(r0.state!);

    // 7 keep-yes reports → the 7th finishes step 0 and commits.
    let finalInstr = r0.instruction;
    for (let i = 0; i < 7; i++) {
      finalInstr = await continueManage(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }
    expect(finalInstr.kind).toBe('done');
    expect(run.subcommand_state).toBeUndefined();

    // JSON round-trips cleanly through loadContract.
    const reloaded = await loadContract(
      join(projectRoot, '.claude', 'ewh-workflows', 'flow.json'),
    );
    expect(reloaded.name).toBe('flow');
    expect(reloaded.steps[0]!.name).toBe('plan');
    expect(reloaded.steps[0]!.gate).toBe('structural');
    expect(reloaded.steps[0]!.chunked).toBe(false);
    expect(reloaded.steps[0]!.script_fallback).toBe('gate');

    // workflow.md matches the renderer output byte-for-byte.
    const md = await fs.readFile(
      join(projectRoot, '.claude', 'ewh-workflows', 'flow.md'),
      'utf8',
    );
    expect(md).toBe(renderWorkflowMd(reloaded));
  });

  it('two-step contract: 14 keep-yes reports finish the run', async () => {
    await writeContract('flow', [
      makeStep({ name: 's1', agent: 'a1' }),
      makeStep({ name: 's2', agent: 'a2' }),
    ]);
    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    const run = makeRun(r0.state!);
    let instr = r0.instruction;
    for (let i = 0; i < 14; i++) {
      instr = await continueManage(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }
    expect(instr.kind).toBe('done');
    expect(run.subcommand_state).toBeUndefined();
  });
});

describe('idempotence', () => {
  it('replaying keep-all decisions produces byte-identical JSON', async () => {
    await writeContract('flow', [
      makeStep({ name: 'plan', agent: 'planner' }),
      makeStep({
        name: 'code',
        agent: 'coder',
        gate: 'auto',
        chunked: true,
        script_fallback: 'auto',
        produces: ['.ewh-artifacts/code.md'],
      }),
    ]);
    const jsonPath = join(projectRoot, '.claude', 'ewh-workflows', 'flow.json');
    const originalBody = await fs.readFile(jsonPath, 'utf8');

    // Run 1
    {
      const r0 = await startManage({
        projectRoot,
        pluginRoot,
        runId: RUN_ID,
        workflowName: 'flow',
      });
      const run = makeRun(r0.state!);
      for (let i = 0; i < 14; i++) {
        await continueManage(
          run,
          { kind: 'decision', step_index: 0, decision: 'yes' },
          { projectRoot, pluginRoot },
        );
      }
    }
    const afterFirst = await fs.readFile(jsonPath, 'utf8');

    // Run 2 (same decisions, fresh run id)
    {
      const r0 = await startManage({
        projectRoot,
        pluginRoot,
        runId: 'mgrun2',
        workflowName: 'flow',
      });
      const run = makeRun(r0.state!);
      run.run_id = 'mgrun2';
      for (let i = 0; i < 14; i++) {
        await continueManage(
          run,
          { kind: 'decision', step_index: 0, decision: 'yes' },
          { projectRoot, pluginRoot },
        );
      }
    }
    const afterSecond = await fs.readFile(jsonPath, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    // Also stable vs the original (which was also canonical).
    expect(afterFirst).toBe(originalBody);
  });
});

describe('replace via --result', () => {
  it('replaces context with a validated JSON array', async () => {
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'coding.md'),
      '---\nname: coding\n---\n',
      'utf8',
    );
    await writeContract('flow', [makeStep({ name: 'plan', agent: 'planner' })]);
    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    const run = makeRun(r0.state!);

    const editFile = join(
      projectRoot,
      '.ewh-artifacts',
      `run-${RUN_ID}`,
      'manage-step-0-context.json',
    );
    await fs.writeFile(
      editFile,
      JSON.stringify([{ type: 'rule', ref: 'coding' }], null, 2),
      'utf8',
    );
    await continueManage(
      run,
      { kind: 'result', step_index: 0, result_path: editFile },
      { projectRoot, pluginRoot },
    );

    // Advance through remaining 6 fields with keep-yes.
    for (let i = 0; i < 6; i++) {
      await continueManage(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }

    const reloaded = await loadContract(
      join(projectRoot, '.claude', 'ewh-workflows', 'flow.json'),
    );
    expect(reloaded.steps[0]!.context).toEqual([
      { type: 'rule', ref: 'coding' },
    ]);
  });

  it('rejects malformed JSON and re-prompts the same field', async () => {
    await writeContract('flow', [makeStep({ name: 'plan', agent: 'planner' })]);
    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    const run = makeRun(r0.state!);

    const editFile = join(
      projectRoot,
      '.ewh-artifacts',
      `run-${RUN_ID}`,
      'manage-step-0-context.json',
    );
    await fs.writeFile(editFile, '{ not valid json', 'utf8');
    const instr = await continueManage(
      run,
      { kind: 'result', step_index: 0, result_path: editFile },
      { projectRoot, pluginRoot },
    );

    expect(instr.kind).toBe('user-prompt');
    expect(instr.body).toMatch(/Previous input rejected/);
    expect(instr.body).toMatch(/Field: context/);
    expect(run.subcommand_state).toMatchObject({
      kind: 'manage',
      field: 'context',
    });
  });
});

describe('clear via --decision no', () => {
  it('clearing context empties the array', async () => {
    await writeContract('flow', [
      makeStep({
        name: 'plan',
        agent: 'planner',
        context: [{ type: 'rule', ref: 'coding' }],
      }),
    ]);
    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    const run = makeRun(r0.state!);

    // Field 0 (context): clear with --decision no
    await continueManage(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    // Advance remaining 6 fields with keep-yes
    for (let i = 0; i < 6; i++) {
      await continueManage(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }

    const reloaded = await loadContract(
      join(projectRoot, '.claude', 'ewh-workflows', 'flow.json'),
    );
    expect(reloaded.steps[0]!.context).toEqual([]);
  });
});

describe('context picker catalog', () => {
  it('lists upstream-produced artifacts for step N', async () => {
    await writeContract('flow', [
      makeStep({
        name: 'plan',
        agent: 'a',
        produces: ['.ewh-artifacts/plan.md'],
      }),
      makeStep({ name: 'code', agent: 'b' }),
    ]);
    const r0 = await startManage({
      projectRoot,
      pluginRoot,
      runId: RUN_ID,
      workflowName: 'flow',
    });
    const run = makeRun(r0.state!);

    // Advance through step 0 (all 7 fields keep-yes). The 7th
    // continueManage call transitions to step 1 context and returns that
    // prompt's Instruction — capture it.
    let step1ContextInstr: typeof r0.instruction | undefined;
    for (let i = 0; i < 7; i++) {
      step1ContextInstr = await continueManage(
        run,
        { kind: 'decision', step_index: 0, decision: 'yes' },
        { projectRoot, pluginRoot },
      );
    }
    expect(run.subcommand_state).toMatchObject({
      kind: 'manage',
      step_index: 1,
      field: 'context',
    });
    expect(step1ContextInstr!.body).toMatch(/Step 2\/2/);
    expect(step1ContextInstr!.body).toMatch(/\.ewh-artifacts\/plan\.md/);
  });
});
