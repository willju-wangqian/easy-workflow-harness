import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startDesign, continueDesign, parseModifyTarget } from '../src/commands/design.js';
import { loadContract } from '../src/workflow/contract-loader.js';
import type { Report, RunState, SubcommandState } from '../src/state/types.js';
import type { WorkflowContract } from '../src/workflow/contract.js';

let tmpDir: string;
let projectRoot: string;
let pluginRoot: string;

const RUN_ID = 'testrun-modify';

const seedContract: WorkflowContract = {
  name: 'wf',
  description: 'seed',
  steps: [
    {
      name: 'plan',
      agent: 'planner',
      description: 'Plan.',
      gate: 'structural',
      produces: ['.ewh-artifacts/plan.md'],
      context: [],
      requires: [],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    },
    {
      name: 'code',
      agent: 'coder',
      description: 'Code.',
      gate: 'structural',
      produces: ['.ewh-artifacts/code.md'],
      context: [{ type: 'artifact', ref: '.ewh-artifacts/plan.md' }],
      requires: [{ prior_step: 'plan', has: 'files_modified' }],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    },
    {
      name: 'review',
      agent: 'reviewer',
      description: 'Review.',
      gate: 'structural',
      produces: ['.ewh-artifacts/review.md'],
      context: [{ type: 'artifact', ref: '.ewh-artifacts/code.md' }],
      requires: [{ prior_step: 'code', has: 'files_modified' }],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    },
  ],
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-design-modify-test-'));
  projectRoot = join(tmpDir, 'project');
  pluginRoot = join(tmpDir, 'plugin');
  for (const dir of [
    join(pluginRoot, 'agents'),
    join(pluginRoot, 'rules'),
    join(projectRoot, '.claude', 'agents'),
    join(projectRoot, '.claude', 'rules'),
    join(projectRoot, '.claude', 'ewh-workflows'),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const a of ['planner', 'coder', 'reviewer']) {
    await fs.writeFile(
      join(pluginRoot, 'agents', `${a}.md`),
      `---\nname: ${a}\n---\n`,
    );
  }
  await fs.writeFile(
    join(projectRoot, '.claude', 'ewh-workflows', 'wf.json'),
    JSON.stringify(seedContract, null, 2) + '\n',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(state: SubcommandState): RunState {
  return {
    run_id: RUN_ID,
    workflow: 'design',
    raw_argv: 'design modify wf:code',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: 'design',
    subcommand_state: state,
  };
}

describe('parseModifyTarget', () => {
  it('parses workflow:step', () => {
    const r = parseModifyTarget('wf:code');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.target).toEqual({ kind: 'workflow-step', workflow: 'wf', step: 'code' });
  });
  it('parses agent:name', () => {
    const r = parseModifyTarget('agent:coder');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ kind: 'agent', name: 'coder' });
  });
  it('parses rule:name', () => {
    const r = parseModifyTarget('rule:coding');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ kind: 'rule', name: 'coding' });
  });
  it('parses bare workflow', () => {
    const r = parseModifyTarget('wf');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ kind: 'workflow', workflow: 'wf' });
  });
  it('rejects empty', () => {
    const r = parseModifyTarget('  ');
    expect(r.ok).toBe(false);
  });
  it('rejects workflow: with no step', () => {
    const r = parseModifyTarget('wf:');
    expect(r.ok).toBe(false);
  });
});

describe('startDesign modify', () => {
  it('fails when no contract exists for the workflow', async () => {
    await fs.rm(
      join(projectRoot, '.claude', 'ewh-workflows', 'wf.json'),
    );
    const r = await startDesign({
      runId: RUN_ID,
      projectRoot,
      pluginRoot,
      description: 'modify wf:code',
    });
    expect(r.state).toBeUndefined();
    expect(r.instruction.kind).toBe('done');
    expect(r.instruction.body).toMatch(/no contract/i);
  });

  it('emits ferry instruction for workflow-step target', async () => {
    const r = await startDesign({
      runId: RUN_ID,
      projectRoot,
      pluginRoot,
      description: 'modify wf:code',
    });
    expect(r.state?.kind).toBe('design');
    if (r.state?.kind === 'design') {
      expect(r.state.phase).toBe('modify_ferry');
    }
    expect(r.instruction.kind).toBe('tool-call');
    expect(r.instruction.body).toMatch(/design-facilitator/);
    expect(r.instruction.body).toMatch(/context_path:/);
    expect(r.instruction.body).toMatch(/output_path:/);

    // Context package written.
    const state = r.state!;
    if (state.kind === 'design' && state.phase === 'modify_ferry') {
      const ctx = await fs.readFile(state.context_path, 'utf8');
      expect(ctx).toMatch(/Current workflow contract/);
      expect(ctx).toMatch(/Target agent: `coder`/);
      expect(ctx).toMatch(/### Rules \(by name\)/);
      expect(ctx).toMatch(/### Declared artifacts/);
      expect(ctx).toMatch(/plan\.md/);
    }
  });
});

describe('continueDesign modify — rename smoke', () => {
  it('applies rename, updates downstream refs, re-renders workflow.md', async () => {
    const start = await startDesign({
      runId: RUN_ID,
      projectRoot,
      pluginRoot,
      description: 'modify wf:code',
    });
    expect(start.state?.kind).toBe('design');
    const state0 = start.state!;
    if (state0.kind !== 'design' || state0.phase !== 'modify_ferry') {
      throw new Error('expected modify_ferry state');
    }

    // Canned proposed.json renaming code → implement.
    await fs.writeFile(
      state0.proposed_path,
      JSON.stringify(
        [{ name: 'implement', _rename_from: 'code' }],
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // Ferry report: result pointing at proposed.json.
    const run1 = makeRun(state0);
    const ferryReport: Report = {
      kind: 'result',
      step_index: 0,
      result_path: state0.proposed_path,
    };
    const afterFerry = await continueDesign(run1, ferryReport, {
      projectRoot,
      pluginRoot,
    });
    expect(afterFerry.kind).toBe('user-prompt');
    expect(afterFerry.body).toMatch(/renamed:\s+code → implement/);

    const reviewState = run1.subcommand_state!;
    if (reviewState.kind !== 'design' || reviewState.phase !== 'modify_review') {
      throw new Error('expected modify_review state after ferry');
    }

    // Approve.
    const run2 = makeRun(reviewState);
    const done = await continueDesign(
      run2,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot, pluginRoot },
    );
    expect(done.kind).toBe('done');
    expect(done.body).toMatch(/Applied design modify/);

    const mergedPath = join(
      projectRoot,
      '.claude',
      'ewh-workflows',
      'wf.json',
    );
    const merged = await loadContract(mergedPath);
    expect(merged.steps.map((s) => s.name)).toEqual([
      'plan',
      'implement',
      'review',
    ]);
    // Review's requires.prior_step was 'code' → now 'implement'.
    const review = merged.steps.find((s) => s.name === 'review')!;
    expect(review.requires).toContainEqual({
      prior_step: 'implement',
      has: 'files_modified',
    });
    // Review's artifact ref: produces path unchanged, so still code.md.
    expect(review.context).toContainEqual({
      type: 'artifact',
      ref: '.ewh-artifacts/code.md',
    });

    // Workflow.md re-rendered.
    const mdPath = join(
      projectRoot,
      '.claude',
      'ewh-workflows',
      'wf.md',
    );
    const md = await fs.readFile(mdPath, 'utf8');
    expect(md).toMatch(/name: implement/);
    expect(md).not.toMatch(/name: code\b/);
  });

  it('reject path discards proposed.json and re-emits the ferry', async () => {
    const start = await startDesign({
      runId: RUN_ID,
      projectRoot,
      pluginRoot,
      description: 'modify wf:code',
    });
    const state0 = start.state!;
    if (state0.kind !== 'design' || state0.phase !== 'modify_ferry') {
      throw new Error('expected modify_ferry state');
    }
    await fs.writeFile(
      state0.proposed_path,
      JSON.stringify([{ name: 'code', description: 'x' }]) + '\n',
      'utf8',
    );

    const run1 = makeRun(state0);
    await continueDesign(
      run1,
      { kind: 'result', step_index: 0, result_path: state0.proposed_path },
      { projectRoot, pluginRoot },
    );
    const reviewState = run1.subcommand_state!;

    const run2 = makeRun(reviewState);
    const next = await continueDesign(
      run2,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot, pluginRoot },
    );
    expect(next.kind).toBe('tool-call');
    expect(next.body).toMatch(/design-facilitator/);
    // proposed.json gone.
    await expect(fs.readFile(state0.proposed_path, 'utf8')).rejects.toThrow();
    // Contract unchanged.
    const json = JSON.parse(
      await fs.readFile(
        join(projectRoot, '.claude', 'ewh-workflows', 'wf.json'),
        'utf8',
      ),
    );
    expect(json.steps.map((s: { name: string }) => s.name)).toEqual([
      'plan',
      'code',
      'review',
    ]);
  });
});
