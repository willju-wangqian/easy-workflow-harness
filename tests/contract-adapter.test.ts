/**
 * Session 2 coverage: JSON-contract → Step[] adapter + prompt assembly
 * from a contract-sourced step.
 *
 * Verifies the plan's Session 2 acceptance test: "Prompt assembly from a
 * JSON contract with a mix of rule / artifact / file entries — assert each
 * lands in the correct section."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contractToWorkflowDef } from '../src/workflow/contract-adapter.js';
import { buildPrompt } from '../src/workflow/prompt-builder.js';
import type { WorkflowContract } from '../src/workflow/contract.js';
import type { RunState } from '../src/state/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-contract-adapter-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(): RunState {
  return {
    run_id: 'test01',
    workflow: 'hello',
    raw_argv: 'hello',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
  };
}

describe('contractToWorkflowDef', () => {
  it('routes rule entries to step.rules and artifact/file entries to step.reads', () => {
    const contract: WorkflowContract = {
      name: 'demo',
      description: 'Mixed context demo.',
      steps: [
        {
          name: 'code',
          agent: 'coder',
          description: 'Write code.',
          gate: 'auto',
          produces: ['.ewh-artifacts/code.md'],
          context: [
            { type: 'rule', ref: 'coding' },
            { type: 'rule', ref: 'testing' },
            { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
            { type: 'file', ref: 'docs/api.md' },
          ],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };

    const wf = contractToWorkflowDef(contract);
    expect(wf.name).toBe('demo');
    expect(wf.description).toBe('Mixed context demo.');
    expect(wf.steps).toHaveLength(1);

    const step = wf.steps[0]!;
    expect(step.name).toBe('code');
    expect(step.agent).toBe('coder');
    expect(step.gate).toBe('auto');
    expect(step.rules).toEqual(['coding', 'testing']);
    expect(step.reads).toEqual(['.ewh-artifacts/plan.md', 'docs/api.md']);
    expect(step.artifact).toBe('.ewh-artifacts/code.md');
    expect(step.context_entries).toEqual(contract.steps[0]!.context);
    expect(step.state).toEqual({ phase: 'pending' });
  });

  it('omits rules/reads when no entries of that type are present', () => {
    const contract: WorkflowContract = {
      name: 'nothing',
      description: '',
      steps: [
        {
          name: 'solo',
          agent: 'coder',
          description: '',
          gate: 'auto',
          produces: [],
          context: [],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };
    const step = contractToWorkflowDef(contract).steps[0]!;
    expect(step.rules).toBeUndefined();
    expect(step.reads).toBeUndefined();
    expect(step.artifact).toBeUndefined();
    expect(step.context_entries).toEqual([]);
  });

  it('maps gate="structural", chunked, script, script_fallback, requires', () => {
    const contract: WorkflowContract = {
      name: 'rich',
      description: '',
      steps: [
        {
          name: 's',
          agent: 'coder',
          description: '',
          gate: 'structural',
          produces: ['a.md'],
          context: [],
          requires: [{ file_exists: 'pre.md' }],
          chunked: true,
          script: 'scripts/s.sh',
          script_fallback: 'auto',
        },
      ],
    };
    const step = contractToWorkflowDef(contract).steps[0]!;
    expect(step.gate).toBe('structural');
    expect(step.chunked).toBe(true);
    expect(step.script).toBe('scripts/s.sh');
    expect(step.script_fallback).toBe('auto');
    expect(step.requires).toEqual([{ file_exists: 'pre.md' }]);
  });
});

describe('buildPrompt with typed context entries', () => {
  it('routes rule entries to ## Active Rules; artifact + file entries to ## Required Reading', async () => {
    const contract: WorkflowContract = {
      name: 'assemble',
      description: '',
      steps: [
        {
          name: 'code',
          agent: 'coder',
          description: 'Do the thing.',
          gate: 'auto',
          produces: [],
          context: [
            { type: 'rule', ref: 'coding' },
            { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
            { type: 'file', ref: 'docs/api.md' },
          ],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };
    const step = contractToWorkflowDef(contract).steps[0]!;

    // The state machine would load rules via rule-loader; we stub a
    // pre-loaded rule here (the adapter only populates step.rules with
    // names; bodies come from loadRulesForStep at dispatch time).
    const { promptPath } = await buildPrompt({
      step,
      agent: { name: 'coder', body: '## Role\n\nCoder.' },
      rules: [
        {
          name: 'coding',
          body: '## Coding\n\nBe careful.',
          path: '/rules/coding.md',
        },
      ],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });

    const content = await fs.readFile(promptPath, 'utf8');

    // Required Reading: artifact + file refs, NOT the rule ref.
    expect(content).toContain('## Required Reading');
    expect(content).toContain('.ewh-artifacts/plan.md');
    expect(content).toContain('docs/api.md');
    const reading = content.slice(
      content.indexOf('## Required Reading'),
      content.indexOf('## Active Rules'),
    );
    expect(reading).not.toMatch(/\bcoding\b/);

    // Active Rules: the loaded rule body.
    expect(content).toContain('## Active Rules');
    expect(content).toContain('### coding');
    expect(content).toContain('Be careful.');

    // Section order preserved.
    const readIdx = content.indexOf('## Required Reading');
    const rulesIdx = content.indexOf('## Active Rules');
    const taskIdx = content.indexOf('## Task');
    expect(readIdx).toBeGreaterThan(0);
    expect(rulesIdx).toBeGreaterThan(readIdx);
    expect(taskIdx).toBeGreaterThan(rulesIdx);
  });

  it('omits Required Reading when only rule entries are present', async () => {
    const contract: WorkflowContract = {
      name: 'rulesonly',
      description: '',
      steps: [
        {
          name: 's',
          agent: 'coder',
          description: '',
          gate: 'auto',
          produces: [],
          context: [{ type: 'rule', ref: 'coding' }],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };
    const step = contractToWorkflowDef(contract).steps[0]!;
    const { promptPath } = await buildPrompt({
      step,
      agent: { name: 'coder', body: 'body.' },
      rules: [{ name: 'coding', body: 'rule body', path: '' }],
      run: makeRun(),
      priorSteps: [],
      harnessConfig: undefined,
      runDirPath: tmpDir,
      stepIndex: 0,
      projectRoot: tmpDir,
    });
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).not.toContain('## Required Reading');
    expect(content).toContain('## Active Rules');
  });
});
