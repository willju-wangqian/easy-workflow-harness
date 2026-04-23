/**
 * Integration tests for the `design` subcommand end-to-end.
 *
 * Uses the same pattern as integration.test.ts: call runStart / runReport
 * directly (no binary spawn), mock agents by writing result files directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStart } from '../src/commands/start.js';
import { runReport } from '../src/commands/report.js';
import type { Report } from '../src/state/types.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

async function writeFile(path: string, content: string) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-design-integ-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');

  await fs.mkdir(join(pluginRoot, 'workflows'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'rules'), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });

  // minimal plugin agent so catalog builder doesn't fail
  await writeFile(
    join(pluginRoot, 'agents', 'coder.md'),
    '---\nname: coder\nmodel: haiku\ntools: [Read, Write, Edit]\nmaxTurns: 5\n---\n\nCoder body.',
  );
  // projectRoot has no package.json → isInsidePluginRepo returns false
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

type Parsed = {
  action: 'tool-call' | 'user-prompt' | 'bash' | 'done';
  body: string;
  reportWith?: string;
  runId?: string;
  resultPath?: string;
};

function parseInstruction(raw: string): Parsed {
  const actionMatch = raw.match(/^ACTION: (\S+)\n([\s\S]*)$/);
  if (!actionMatch) throw new Error(`cannot parse instruction: ${raw}`);
  const action = actionMatch[1] as Parsed['action'];
  const restBody = actionMatch[2]!;
  const reportIdx = restBody.lastIndexOf('\nREPORT_WITH: ');
  const body = reportIdx === -1 ? restBody : restBody.slice(0, reportIdx);
  const reportWith =
    reportIdx === -1 ? undefined : restBody.slice(reportIdx + '\nREPORT_WITH: '.length).trim();
  const runId = reportWith?.match(/--run (\S+)/)?.[1];
  const resultPath =
    reportWith?.match(/--result (\S+)/)?.[1] ??
    body.match(/--result (\S+)/)?.[1];
  return { action, body, reportWith, runId, resultPath };
}

async function doReport(runId: string, report: Report): Promise<Parsed> {
  const result = await runReport({ projectRoot, pluginRoot, runId, stepIndex: 0, report });
  return parseInstruction(result);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('design subcommand — missing description', () => {
  it('emits done with usage hint when description is empty', async () => {
    const out = await runStart({ projectRoot, pluginRoot, rawArgv: 'design' });
    const parsed = parseInstruction(out);
    expect(parsed.action).toBe('done');
    expect(parsed.body).toContain('missing description');
  });
});

describe('design subcommand — happy path (2 artifacts)', () => {
  it('interview → shape gate → 2× author → 2× file gate → write → files on disk', async () => {
    // ── Step 1: start design ──────────────────────────────────────────────
    const out = await runStart({
      projectRoot,
      pluginRoot,
      rawArgv: 'design add a rule and an agent',
    });
    const first = parseInstruction(out);
    expect(first.action).toBe('tool-call');
    expect(first.body).toContain('design-facilitator');
    expect(first.runId).toBeDefined();

    const shapePath = first.resultPath;
    expect(shapePath).toBeDefined();
    expect(shapePath).toContain('shape.json');

    // ── Step 2: mock facilitator → write shape.json ───────────────────────
    const proposal = {
      description: 'add a rule and an agent',
      artifacts: [
        {
          type: 'rule',
          op: 'create',
          name: 'test-rule',
          scope: 'project',
          path: 'rules/test-rule.md',
          description: 'A test rule',
          frontmatter: { name: 'test-rule', description: 'A test rule' },
        },
        {
          type: 'agent',
          op: 'create',
          name: 'test-agent',
          scope: 'project',
          path: 'agents/test-agent.md',
          description: 'A test agent',
          frontmatter: { name: 'test-agent', description: 'A test agent', model: 'sonnet', tools: ['Read'] },
        },
      ],
    };
    await writeFile(shapePath!, JSON.stringify(proposal, null, 2));

    // ── Step 3: report shape → shape gate ────────────────────────────────
    const shapeGate = await doReport(first.runId!, {
      kind: 'result',
      step_index: 0,
      result_path: shapePath,
    });
    expect(shapeGate.action).toBe('user-prompt');
    expect(shapeGate.body).toContain('shape gate');
    expect(shapeGate.body).toContain('test-rule');
    expect(shapeGate.body).toContain('test-agent');

    // ── Step 4: approve shape gate → author[0] ────────────────────────────
    const author0 = await doReport(first.runId!, {
      kind: 'decision',
      step_index: 0,
      decision: 'yes',
    });
    expect(author0.action).toBe('tool-call');
    expect(author0.body).toContain('artifact-author');

    const staged0 = author0.resultPath;
    expect(staged0).toBeDefined();

    // ── Step 5: mock author[0] → write staged rule ────────────────────────
    const ruleContent = [
      '---',
      'name: test-rule',
      'description: A test rule',
      'scope: project',
      'severity: info',
      'inject_into: []',
      '---',
      '',
      'Follow this rule in all circumstances.',
    ].join('\n') + '\n';
    await writeFile(staged0!, ruleContent);

    // ── Step 6: report author[0] → author[1] ─────────────────────────────
    const author1 = await doReport(first.runId!, {
      kind: 'result',
      step_index: 0,
      result_path: staged0,
    });
    expect(author1.action).toBe('tool-call');
    expect(author1.body).toContain('artifact-author');

    const staged1 = author1.resultPath;
    expect(staged1).toBeDefined();

    // ── Step 7: mock author[1] → write staged agent ───────────────────────
    const agentContent = [
      '---',
      'name: test-agent',
      'description: A test agent',
      'model: sonnet',
      'tools: [Read]',
      'maxTurns: 5',
      '---',
      '',
      '## Before You Start',
      '',
      'Verify context is sufficient before proceeding.',
      '',
      '## Task',
      '',
      'Do the task.',
      '',
      'AGENT_COMPLETE',
    ].join('\n') + '\n';
    await writeFile(staged1!, agentContent);

    // ── Step 8: report author[1] → file gate[0] ──────────────────────────
    const fileGate0 = await doReport(first.runId!, {
      kind: 'result',
      step_index: 0,
      result_path: staged1,
    });
    expect(fileGate0.action).toBe('user-prompt');
    expect(fileGate0.body).toContain('file gate');
    expect(fileGate0.body).toContain('1/2');

    // ── Step 9: approve file gate[0] → file gate[1] ──────────────────────
    const fileGate1 = await doReport(first.runId!, {
      kind: 'decision',
      step_index: 0,
      decision: 'yes',
    });
    expect(fileGate1.action).toBe('user-prompt');
    expect(fileGate1.body).toContain('file gate');
    expect(fileGate1.body).toContain('2/2');

    // ── Step 10: approve file gate[1] → done (write) ─────────────────────
    const done = await doReport(first.runId!, {
      kind: 'decision',
      step_index: 0,
      decision: 'yes',
    });
    expect(done.action).toBe('done');
    expect(done.body).toContain('Wrote 2 artifact');

    // ── Step 11: verify final files on disk ───────────────────────────────
    const writtenRule = await fs.readFile(
      join(projectRoot, '.claude', 'rules', 'test-rule.md'),
      'utf8',
    );
    expect(writtenRule).toContain('name: test-rule');

    const writtenAgent = await fs.readFile(
      join(projectRoot, '.claude', 'agents', 'test-agent.md'),
      'utf8',
    );
    expect(writtenAgent).toContain('name: test-agent');
  });
});

describe('design subcommand — scope:plugin auto-rewrite cascades to frontmatter', () => {
  it('rewrites both top-level scope and frontmatter.scope in a non-plugin project', async () => {
    const out = await runStart({ projectRoot, pluginRoot, rawArgv: 'design make a rule' });
    const first = parseInstruction(out);
    const shapePath = first.resultPath!;

    const proposal = {
      description: 'make a rule',
      artifacts: [{
        type: 'rule',
        op: 'create',
        name: 'scoped-rule',
        scope: 'plugin',
        path: 'rules/scoped-rule.md',
        description: 'Scope should be rewritten end-to-end',
        frontmatter: { name: 'scoped-rule', scope: 'plugin', severity: 'info' },
      }],
    };
    await writeFile(shapePath, JSON.stringify(proposal, null, 2));

    const gate = await doReport(first.runId!, { kind: 'result', step_index: 0, result_path: shapePath });
    expect(gate.action).toBe('user-prompt');
    expect(gate.body).toContain('Auto-rewrote');

    const persisted = JSON.parse(await fs.readFile(shapePath, 'utf8')) as typeof proposal;
    expect(persisted.artifacts[0]!.scope).toBe('project');
    expect((persisted.artifacts[0]!.frontmatter as { scope?: unknown }).scope).toBe('project');
  });
});

describe('design subcommand — shape gate reject', () => {
  it('decision no at shape gate emits done with no files written', async () => {
    const out = await runStart({ projectRoot, pluginRoot, rawArgv: 'design make a rule' });
    const first = parseInstruction(out);
    const shapePath = first.resultPath!;

    const proposal = {
      description: 'make a rule',
      artifacts: [{
        type: 'rule',
        op: 'create',
        name: 'reject-rule',
        scope: 'project',
        path: 'rules/reject-rule.md',
        description: 'Will be rejected',
        frontmatter: { name: 'reject-rule' },
      }],
    };
    await writeFile(shapePath, JSON.stringify(proposal, null, 2));

    await doReport(first.runId!, { kind: 'result', step_index: 0, result_path: shapePath });

    const done = await doReport(first.runId!, { kind: 'decision', step_index: 0, decision: 'no' });
    expect(done.action).toBe('done');
    expect(done.body).toContain('rejected');

    // no files written
    await expect(
      fs.access(join(projectRoot, '.claude', 'rules', 'reject-rule.md')),
    ).rejects.toThrow();
  });
});

describe('design subcommand — file gate reject', () => {
  it('decision no at file gate aborts with no files written', async () => {
    const out = await runStart({ projectRoot, pluginRoot, rawArgv: 'design make a rule' });
    const first = parseInstruction(out);
    const shapePath = first.resultPath!;

    const proposal = {
      description: 'make a rule',
      artifacts: [{
        type: 'rule',
        op: 'create',
        name: 'abort-rule',
        scope: 'project',
        path: 'rules/abort-rule.md',
        description: 'Will be aborted at file gate',
        frontmatter: { name: 'abort-rule' },
      }],
    };
    await writeFile(shapePath, JSON.stringify(proposal, null, 2));
    await doReport(first.runId!, { kind: 'result', step_index: 0, result_path: shapePath });
    const author = await doReport(first.runId!, { kind: 'decision', step_index: 0, decision: 'yes' });

    const staged = author.resultPath!;
    await writeFile(staged, '---\nname: abort-rule\n---\n\nBody.\n');

    const fileGate = await doReport(first.runId!, {
      kind: 'result',
      step_index: 0,
      result_path: staged,
    });
    expect(fileGate.action).toBe('user-prompt');

    const done = await doReport(first.runId!, { kind: 'decision', step_index: 0, decision: 'no' });
    expect(done.action).toBe('done');
    expect(done.body).toContain('Rejected');
    expect(done.body).toContain('No files written');

    await expect(
      fs.access(join(projectRoot, '.claude', 'rules', 'abort-rule.md')),
    ).rejects.toThrow();
  });
});

describe('create subcommand — deprecation', () => {
  it('emits done with deprecation message pointing to design', async () => {
    const out = await runStart({ projectRoot, pluginRoot, rawArgv: 'create rule' });
    const parsed = parseInstruction(out);
    expect(parsed.action).toBe('done');
    expect(parsed.body).toContain('replaced by `design`');
    expect(parsed.body).toContain('/ewh:doit design');
  });
});
