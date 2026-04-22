/**
 * End-to-end round-trip for the Context Contract (Session 6).
 *
 * Exercises, in order:
 *   1. `migrate` — legacy YAML → .claude/ewh-workflows/<name>.{md,json}
 *   2. Runtime `start` — loads the converted JSON contract and assembles
 *      a prompt with the correct typed-context routing.
 *   3. `diffContract` rename — ensures downstream refs update.
 *   4. `doctor` — passes cleanly on the valid fixture; fails on a contrived
 *      dangling-rule ref.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStart } from '../src/commands/start.js';
import { startMigrate, continueMigrate, legacyToContract } from '../src/commands/migrate.js';
import { loadContract } from '../src/workflow/contract-loader.js';
import { loadWorkflow } from '../src/workflow/parse.js';
import { renderWorkflowMd } from '../src/workflow/render-md.js';
import { diffContract } from '../src/workflow/contract-diff.js';
import { runDoctor } from '../src/commands/doctor.js';
import type { RunState, Report } from '../src/state/types.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

async function writeFileEnsuring(path: string, content: string, mode?: number) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, mode !== undefined ? { mode } : 'utf8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-ctx-contract-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');

  // Plugin scaffolding — agent + one rule the legacy workflow references.
  await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'rules'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'workflows'), { recursive: true });
  await writeFileEnsuring(
    join(pluginRoot, 'agents', 'coder.md'),
    '---\nname: coder\nmodel: haiku\ntools: [Read, Write]\nmaxTurns: 5\ndefault_rules: [coding]\n---\n\nCoder body.\n\nAGENT_COMPLETE\n',
  );
  await writeFileEnsuring(
    join(pluginRoot, 'agents', 'reviewer.md'),
    '---\nname: reviewer\nmodel: haiku\ntools: [Read]\nmaxTurns: 5\n---\n\nReviewer body.\n\nAGENT_COMPLETE\n',
  );
  await writeFileEnsuring(
    join(pluginRoot, 'rules', 'coding.md'),
    '---\nname: coding\n---\n\nCoding rule body.\n',
  );

  // Minimal plugin package.json so doctor's node-version check passes.
  await writeFileEnsuring(
    join(pluginRoot, 'package.json'),
    JSON.stringify({ engines: { node: '>=18' } }, null, 2),
  );
  await fs.mkdir(join(pluginRoot, 'hooks'), { recursive: true });
  await writeFileEnsuring(join(pluginRoot, 'hooks', 'hooks.json'), '{}\n');
  await fs.mkdir(join(pluginRoot, 'bin'), { recursive: true });
  await writeFileEnsuring(
    join(pluginRoot, 'bin', 'ewh.mjs'),
    '#!/usr/bin/env node\n',
    0o755,
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Context Contract round-trip', () => {
  it('migrate → runtime loads JSON → prompt has typed context', async () => {
    // 1. Seed a legacy YAML workflow in the project.
    await writeFileEnsuring(
      join(projectRoot, '.claude', 'workflows', 'demo.md'),
      [
        '---',
        'name: demo',
        'description: two-step demo',
        '---',
        '',
        '## Steps',
        '',
        '- name: plan',
        '  agent: coder',
        '  gate: auto',
        '  rules: [coding]',
        '  artifact: .ewh-artifacts/plan.md',
        '  description: Plan it.',
        '',
        '- name: review',
        '  agent: reviewer',
        '  gate: auto',
        '  reads: [.ewh-artifacts/plan.md]',
        '  description: Review the plan.',
        '',
      ].join('\n'),
    );

    // 2. Run migrate.start → confirm → continue with decision=yes.
    const start = await startMigrate({ projectRoot, pluginRoot });
    expect(start.state?.kind).toBe('migrate');
    expect(start.instruction.kind).toBe('user-prompt');
    expect(start.instruction.body).toContain('demo');

    const run: RunState = {
      run_id: 'run-ctx',
      workflow: 'migrate',
      raw_argv: 'migrate',
      current_step_index: 0,
      steps: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'running',
      subcommand: 'migrate',
      subcommand_state: start.state,
    };
    const approve: Report = { kind: 'decision', step_index: 0, decision: 'yes' };
    const done = await continueMigrate(run, approve, { projectRoot, pluginRoot });
    expect(done.kind).toBe('done');
    expect(done.body).toContain('converted 1');

    // 3. Converted files exist and parse.
    const jsonPath = join(projectRoot, '.claude', 'ewh-workflows', 'demo.json');
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    const contract = await loadContract(jsonPath);
    expect(contract.steps[0]!.name).toBe('plan');
    expect(contract.steps[0]!.produces).toEqual(['.ewh-artifacts/plan.md']);
    expect(contract.steps[0]!.context).toEqual([{ type: 'rule', ref: 'coding' }]);
    expect(contract.steps[1]!.context).toEqual([
      { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
    ]);

    // Re-rendering the contract produces byte-identical MD on every call.
    const md = await fs.readFile(mdPath, 'utf8');
    expect(md).toBe(renderWorkflowMd(contract));

    // 4. Runtime picks up the JSON path (no YAML fallback).
    // Pre-create the plan artifact the review step reads (contract-driven).
    await writeFileEnsuring(
      join(projectRoot, '.ewh-artifacts', 'plan.md'),
      'plan body\n',
    );
    const rawStart = await runStart({
      projectRoot,
      pluginRoot,
      rawArgv: 'demo',
    });
    expect(rawStart).toMatch(/^ACTION: /);

    // Assert the first step's prompt sourced rules + artifacts from JSON.
    const artifactsDir = join(projectRoot, '.ewh-artifacts');
    const runs = (await fs.readdir(artifactsDir)).filter((n) => n.startsWith('run-'));
    expect(runs.length).toBeGreaterThan(0);
    const runDir = runs[0]!;
    const promptPath = join(artifactsDir, runDir, 'step-0-prompt.md');
    const prompt = await fs.readFile(promptPath, 'utf8');
    expect(prompt).toContain('## Active Rules');
    expect(prompt).toContain('Coding rule body.');

    // 5. Rename step 'plan' → 'draft' via diffContract; downstream artifact
    // ref still points at the same .ewh-artifacts/plan.md path (the diff
    // preserves cross-step refs by not rewriting artifact paths on rename).
    const proposed = {
      steps: [
        {
          _rename_from: 'plan',
          name: 'draft',
          agent: 'coder',
          description: 'Draft it.',
          gate: 'auto' as const,
          produces: ['.ewh-artifacts/plan.md'],
          context: [{ type: 'rule' as const, ref: 'coding' }],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate' as const,
        },
      ],
    };
    const diff = diffContract(contract, proposed);
    expect(diff.renamed).toEqual([{ from: 'plan', to: 'draft' }]);
    expect(diff.errors).toEqual([]);
    expect(diff.merged.steps[0]!.name).toBe('draft');
    // Step 2 still references the artifact by path, not by step name.
    expect(diff.merged.steps[1]!.context).toEqual([
      { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
    ]);
  });

  it('doctor passes on the migrated fixture; fails on a dangling rule ref', async () => {
    // Scaffold via legacyToContract + write.
    const legacy = await loadWorkflow(
      await seedLegacy(projectRoot, 'demo', [
        { name: 'plan', agent: 'coder', rules: ['coding'] },
      ]),
    );
    const contract = legacyToContract(legacy);
    await writeFileEnsuring(
      join(projectRoot, '.claude', 'ewh-workflows', 'demo.json'),
      JSON.stringify(contract, null, 2) + '\n',
    );
    await writeFileEnsuring(
      join(projectRoot, '.claude', 'ewh-workflows', 'demo.md'),
      renderWorkflowMd(contract),
    );

    const clean = await runDoctor({ projectRoot, pluginRoot });
    const cCheck = clean.results.find((c) => c.id === 11)!;
    expect(cCheck.status).toBe('pass');

    // Break it: introduce a context ref to a rule that doesn't exist.
    const broken = structuredClone(contract);
    broken.steps[0]!.context.push({ type: 'rule', ref: 'nonexistent-rule' });
    await writeFileEnsuring(
      join(projectRoot, '.claude', 'ewh-workflows', 'demo.json'),
      JSON.stringify(broken, null, 2) + '\n',
    );

    const bad = await runDoctor({ projectRoot, pluginRoot });
    const bCheck = bad.results.find((c) => c.id === 11)!;
    expect(bCheck.status).toBe('fail');
    expect(
      bCheck.issues!.some((i) =>
        i.includes("rule 'nonexistent-rule' not found"),
      ),
    ).toBe(true);
  });
});

async function seedLegacy(
  projectRoot: string,
  name: string,
  steps: Array<{ name: string; agent: string; rules?: string[] }>,
): Promise<string> {
  const body =
    [
      '---',
      `name: ${name}`,
      '---',
      '',
      '## Steps',
      '',
      ...steps.flatMap((s) => [
        `- name: ${s.name}`,
        `  agent: ${s.agent}`,
        '  gate: auto',
        ...(s.rules && s.rules.length > 0
          ? [`  rules: [${s.rules.join(', ')}]`]
          : []),
        '',
      ]),
    ].join('\n') + '\n';
  const path = join(projectRoot, '.claude', 'workflows', `${name}.md`);
  await writeFileEnsuring(path, body);
  return path;
}
