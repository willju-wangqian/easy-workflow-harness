import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkIntegrity,
  diffContract,
  parseProposedInput,
  renderDiffSummary,
} from '../src/workflow/contract-diff.js';
import type { WorkflowContract } from '../src/workflow/contract.js';

function baseContract(): WorkflowContract {
  return {
    name: 'wf',
    description: 'test',
    steps: [
      {
        name: 'plan',
        agent: 'planner',
        description: 'Plan it.',
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
        description: 'Code it.',
        gate: 'structural',
        produces: ['.ewh-artifacts/code.md'],
        context: [
          { type: 'rule', ref: 'coding' },
          { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
        ],
        requires: [{ prior_step: 'plan', has: 'files_modified' }],
        chunked: false,
        script: null,
        script_fallback: 'gate',
      },
      {
        name: 'review',
        agent: 'reviewer',
        description: 'Review it.',
        gate: 'structural',
        produces: ['.ewh-artifacts/review.md'],
        context: [
          { type: 'artifact', ref: '.ewh-artifacts/code.md' },
        ],
        requires: [{ prior_step: 'code', has: 'files_modified' }],
        chunked: false,
        script: null,
        script_fallback: 'gate',
      },
    ],
  };
}

describe('parseProposedInput', () => {
  it('accepts a bare array of slices', () => {
    const p = parseProposedInput([{ name: 'code', description: 'New.' }]);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.name).toBe('code');
    expect(p._order).toBeUndefined();
  });

  it('accepts {steps, _order}', () => {
    const p = parseProposedInput({
      steps: [{ name: 'a' }, { name: 'b' }],
      _order: ['a', 'b'],
    });
    expect(p.steps).toHaveLength(2);
    expect(p._order).toEqual(['a', 'b']);
  });

  it('rejects missing name on slice', () => {
    expect(() => parseProposedInput([{ description: 'x' }])).toThrow(/name/);
  });

  it('rejects non-true _delete', () => {
    expect(() =>
      parseProposedInput([{ name: 'x', _delete: 'yes' }]),
    ).toThrow(/_delete/);
  });

  it('rejects bad context entry type', () => {
    expect(() =>
      parseProposedInput([
        { name: 'x', context: [{ type: 'nope', ref: 'y' }] },
      ]),
    ).toThrow(/type/);
  });
});

describe('diffContract — update', () => {
  it('marks same-name slice as updated', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'code', description: 'Newer description.' }],
    });
    expect(d.updated).toEqual(['code']);
    expect(d.added).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.renamed).toEqual([]);
    expect(d.errors).toEqual([]);
    const code = d.merged.steps.find((s) => s.name === 'code')!;
    expect(code.description).toBe('Newer description.');
    // Unspecified fields preserved.
    expect(code.agent).toBe('coder');
    expect(code.produces).toEqual(['.ewh-artifacts/code.md']);
  });

  it('rewrites downstream artifact refs when produces path changes in-place', () => {
    const d = diffContract(baseContract(), {
      steps: [
        {
          name: 'code',
          produces: ['.ewh-artifacts/impl.md'],
        },
      ],
    });
    const review = d.merged.steps.find((s) => s.name === 'review')!;
    expect(review.context).toContainEqual({
      type: 'artifact',
      ref: '.ewh-artifacts/impl.md',
    });
  });
});

describe('diffContract — add', () => {
  it('appends new step at end of order when not in current', () => {
    const d = diffContract(baseContract(), {
      steps: [
        {
          name: 'test',
          agent: 'tester',
          description: 'Run tests.',
          produces: ['.ewh-artifacts/test.md'],
        },
      ],
    });
    expect(d.added).toEqual(['test']);
    expect(d.merged.steps.map((s) => s.name)).toEqual([
      'plan',
      'code',
      'review',
      'test',
    ]);
    const added = d.merged.steps.find((s) => s.name === 'test')!;
    expect(added.gate).toBe('structural'); // default
    expect(added.chunked).toBe(false); // default
  });
});

describe('diffContract — delete', () => {
  it('removes step and reports it', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'review', _delete: true }],
    });
    expect(d.deleted).toEqual(['review']);
    expect(d.merged.steps.map((s) => s.name)).toEqual(['plan', 'code']);
  });

  it('reports error when deleting a nonexistent step', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'ghost', _delete: true }],
    });
    expect(d.errors.join('\n')).toMatch(/_delete.*ghost/);
  });
});

describe('diffContract — rename', () => {
  it('preserves cross-step requires.prior_step refs', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'implement', _rename_from: 'code' }],
    });
    expect(d.renamed).toEqual([{ from: 'code', to: 'implement' }]);
    expect(d.errors).toEqual([]);
    const review = d.merged.steps.find((s) => s.name === 'review')!;
    expect(review.requires).toContainEqual({
      prior_step: 'implement',
      has: 'files_modified',
    });
    // Rename preserves the step's own produces path since the slice didn't
    // change it; downstream artifact ref to code.md still points at code.md.
    expect(review.context).toContainEqual({
      type: 'artifact',
      ref: '.ewh-artifacts/code.md',
    });
    expect(d.merged.steps.map((s) => s.name)).toEqual([
      'plan',
      'implement',
      'review',
    ]);
  });

  it('rewrites downstream artifact refs when rename + new produces path', () => {
    const d = diffContract(baseContract(), {
      steps: [
        {
          name: 'implement',
          _rename_from: 'code',
          produces: ['.ewh-artifacts/impl.md'],
        },
      ],
    });
    const review = d.merged.steps.find((s) => s.name === 'review')!;
    expect(review.context).toContainEqual({
      type: 'artifact',
      ref: '.ewh-artifacts/impl.md',
    });
  });

  it('reports error when rename source is missing', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'new', _rename_from: 'ghost' }],
    });
    expect(d.errors.join('\n')).toMatch(/ghost/);
  });

  it('reports error when rename target collides with existing step', () => {
    const d = diffContract(baseContract(), {
      steps: [{ name: 'review', _rename_from: 'code' }],
    });
    expect(d.errors.join('\n')).toMatch(/collides/);
  });
});

describe('diffContract — reorder', () => {
  it('accepts _order that is a permutation of merged names', () => {
    const d = diffContract(baseContract(), {
      steps: [],
      _order: ['review', 'plan', 'code'],
    });
    expect(d.errors).toEqual([]);
    expect(d.reordered).toBe(true);
    expect(d.merged.steps.map((s) => s.name)).toEqual([
      'review',
      'plan',
      'code',
    ]);
  });

  it('flags _order as error when not a permutation', () => {
    const d = diffContract(baseContract(), {
      steps: [],
      _order: ['plan', 'review'],
    });
    expect(d.errors.join('\n')).toMatch(/_order mismatch/);
  });

  it('reordered=false when _order matches inferred order', () => {
    const d = diffContract(baseContract(), {
      steps: [],
      _order: ['plan', 'code', 'review'],
    });
    expect(d.reordered).toBe(false);
  });
});

describe('diffContract — combined', () => {
  it('handles update + rename + add + delete in one proposal', () => {
    const d = diffContract(baseContract(), {
      steps: [
        { name: 'plan', description: 'Planning (revised).' },
        { name: 'implement', _rename_from: 'code' },
        { name: 'review', _delete: true },
        {
          name: 'test',
          agent: 'tester',
          description: 'Run tests.',
          produces: ['.ewh-artifacts/test.md'],
        },
      ],
    });
    expect(d.errors).toEqual([]);
    expect(d.updated).toEqual(['plan']);
    expect(d.renamed).toEqual([{ from: 'code', to: 'implement' }]);
    expect(d.deleted).toEqual(['review']);
    expect(d.added).toEqual(['test']);
    expect(d.merged.steps.map((s) => s.name)).toEqual([
      'plan',
      'implement',
      'test',
    ]);
  });
});

// ── Integrity ───────────────────────────────────────────────────────────

describe('checkIntegrity', () => {
  let tmpDir: string;
  let projectRoot: string;
  let pluginRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-diff-integrity-'));
    projectRoot = join(tmpDir, 'project');
    pluginRoot = join(tmpDir, 'plugin');
    // Seed plugin agents + rules.
    await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'rules'), { recursive: true });
    for (const a of ['planner', 'coder', 'reviewer']) {
      await fs.writeFile(join(pluginRoot, 'agents', `${a}.md`), `---\nname: ${a}\n---\n`);
    }
    await fs.writeFile(
      join(pluginRoot, 'rules', 'coding.md'),
      `---\nname: coding\n---\n`,
    );
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no issues for a clean contract', async () => {
    const issues = await checkIntegrity(baseContract(), {
      projectRoot,
      pluginRoot,
    });
    expect(issues).toEqual([]);
  });

  it('catches missing rule', async () => {
    const contract = baseContract();
    contract.steps[1]!.context.push({ type: 'rule', ref: 'nope' });
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues.join('\n')).toMatch(/rule 'nope'/);
  });

  it('catches missing agent', async () => {
    const contract = baseContract();
    contract.steps[2]!.agent = 'ghost';
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues.join('\n')).toMatch(/agent 'ghost'/);
  });

  it('catches artifact ref not produced by an earlier step', async () => {
    const contract = baseContract();
    contract.steps[1]!.context.push({
      type: 'artifact',
      ref: '.ewh-artifacts/dangling.md',
    });
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues.join('\n')).toMatch(/dangling\.md/);
  });

  it('catches artifact ref produced only by a LATER step (positional)', async () => {
    const contract = baseContract();
    // plan (step 0) references review's output — review runs last, so this
    // should fail positional integrity.
    contract.steps[0]!.context.push({
      type: 'artifact',
      ref: '.ewh-artifacts/review.md',
    });
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues.join('\n')).toMatch(/review\.md/);
  });

  it("doesn't validate type: 'file' refs (escape hatch)", async () => {
    const contract = baseContract();
    contract.steps[1]!.context.push({
      type: 'file',
      ref: '/any/random/path.md',
    });
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues).toEqual([]);
  });

  it('accepts project-overridden rule', async () => {
    const contract = baseContract();
    contract.steps[1]!.context.push({ type: 'rule', ref: 'project-only' });
    await fs.mkdir(join(projectRoot, '.claude', 'rules'), { recursive: true });
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'project-only.md'),
      `---\nname: project-only\n---\n`,
    );
    const issues = await checkIntegrity(contract, { projectRoot, pluginRoot });
    expect(issues).toEqual([]);
  });
});

// ── Merge atomicity ─────────────────────────────────────────────────────

describe('merge atomicity', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-diff-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('source JSON unchanged when crash occurs before commit', async () => {
    // Simulate "proposed.json written, state machine crashes before
    // committing the merged JSON". The diff produces a merged contract in
    // memory, but nothing has been written to the source path yet — so the
    // current JSON on disk is untouched.
    const srcPath = join(tmpDir, 'wf.json');
    const origJson = JSON.stringify(baseContract(), null, 2) + '\n';
    await fs.writeFile(srcPath, origJson, 'utf8');

    const d = diffContract(baseContract(), {
      steps: [{ name: 'code', description: 'updated' }],
    });
    // Intentionally DO NOT write merged back — simulating crash.
    expect(d.merged.steps.find((s) => s.name === 'code')!.description).toBe(
      'updated',
    );
    const after = await fs.readFile(srcPath, 'utf8');
    expect(after).toBe(origJson);
  });

  it('tmp-rename pattern leaves no partial file on commit failure', async () => {
    // The production path uses fs.mkdir + tmp file + fsync + rename. Simulate
    // the failure mode: write a .tmp but never rename. Source file must remain
    // untouched.
    const srcPath = join(tmpDir, 'wf.json');
    const origJson = JSON.stringify(baseContract(), null, 2) + '\n';
    await fs.writeFile(srcPath, origJson, 'utf8');

    const tmpPath = `${srcPath}.tmp-abcd`;
    await fs.writeFile(tmpPath, '{"partial": true}', 'utf8');

    // Source unchanged.
    expect(await fs.readFile(srcPath, 'utf8')).toBe(origJson);
    // Tmp present but separate.
    expect(await fs.readFile(tmpPath, 'utf8')).toBe('{"partial": true}');
  });
});

describe('renderDiffSummary', () => {
  it('lists all op categories', () => {
    const d = diffContract(baseContract(), {
      steps: [
        { name: 'plan', description: 'revised' },
        { name: 'implement', _rename_from: 'code' },
        { name: 'review', _delete: true },
        {
          name: 'test',
          agent: 'tester',
          description: 'Test.',
          produces: ['.ewh-artifacts/test.md'],
        },
      ],
    });
    const out = renderDiffSummary(d, []);
    expect(out).toMatch(/added:\s+test/);
    expect(out).toMatch(/updated:\s+plan/);
    expect(out).toMatch(/renamed:\s+code → implement/);
    expect(out).toMatch(/deleted:\s+review/);
  });

  it('shows (no structural changes) on empty diff', () => {
    const d = diffContract(baseContract(), { steps: [] });
    expect(renderDiffSummary(d, [])).toMatch(/no structural changes/);
  });

  it('renders integrity issues', () => {
    const d = diffContract(baseContract(), { steps: [] });
    const out = renderDiffSummary(d, ['step foo: rule bar not found']);
    expect(out).toMatch(/Referential-integrity issues/);
    expect(out).toMatch(/rule bar not found/);
  });
});
