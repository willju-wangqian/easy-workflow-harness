import { describe, it, expect } from 'vitest';
import { renderWorkflowMd } from '../src/workflow/render-md.js';
import type { WorkflowContract } from '../src/workflow/contract.js';

const contract: WorkflowContract = {
  name: 'add-feature',
  description: 'Plan, implement, review, and test a new feature.',
  steps: [
    {
      name: 'plan',
      agent: 'planner',
      description: 'Design the feature.',
      gate: 'structural',
      produces: [],
      context: [],
      requires: [],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    },
    {
      name: 'code',
      agent: 'coder',
      description: 'Implement the plan; run tests.',
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

describe('renderWorkflowMd', () => {
  it('produces byte-identical output on repeated calls', () => {
    const a = renderWorkflowMd(contract);
    const b = renderWorkflowMd(contract);
    expect(a).toBe(b);
  });

  it('includes frontmatter, ## Steps heading, and per-step fields', () => {
    const md = renderWorkflowMd(contract);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toMatch(/\nname: add-feature\n/);
    expect(md).toMatch(/\ndescription: Plan, implement/);
    expect(md).toMatch(/\n---\n/);
    expect(md).toMatch(/\n## Steps\n/);
    expect(md).toMatch(/- name: plan/);
    expect(md).toMatch(/agent: planner/);
    expect(md).toMatch(/description: Design the feature\./);
    expect(md).toMatch(/- name: code/);
    expect(md).toMatch(/agent: coder/);
  });

  it('preserves key order (name, agent, description) per step', () => {
    const md = renderWorkflowMd(contract);
    const planNameIdx = md.indexOf('- name: plan');
    const planAgentIdx = md.indexOf('agent: planner', planNameIdx);
    const planDescIdx = md.indexOf('description: Design', planAgentIdx);
    expect(planNameIdx).toBeGreaterThan(-1);
    expect(planAgentIdx).toBeGreaterThan(planNameIdx);
    expect(planDescIdx).toBeGreaterThan(planAgentIdx);
  });

  it('has no trailing whitespace on any line', () => {
    const md = renderWorkflowMd(contract);
    for (const line of md.split('\n')) {
      expect(line).toBe(line.replace(/[ \t]+$/, ''));
    }
  });
});
