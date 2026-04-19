import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRulesForStep } from '../src/workflow/rule-loader.js';

async function mkdir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, content: string) {
  await mkdir(join(p, '..'));
  await fs.writeFile(p, content, 'utf8');
}

const RULE_FM = (name: string) =>
  `---\nname: ${name}\ndescription: test rule\nseverity: default\n---\n\n`;

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-rule-test-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');
  await mkdir(join(pluginRoot, 'rules'));
  await mkdir(join(projectRoot, '.claude', 'rules'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadRulesForStep', () => {
  it('returns empty array for empty rule names', async () => {
    const rules = await loadRulesForStep([], pluginRoot, projectRoot);
    expect(rules).toEqual([]);
  });

  it('returns empty array when rule file does not exist', async () => {
    const rules = await loadRulesForStep(['missing'], pluginRoot, projectRoot);
    expect(rules).toEqual([]);
  });

  it('loads a plugin rule', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'coding.md'),
      `${RULE_FM('coding')}## Principles\n\nDo good work.`,
    );
    const rules = await loadRulesForStep(['coding'], pluginRoot, projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('coding');
    expect(rules[0]!.body).toContain('Do good work.');
  });

  it('loads a project rule', async () => {
    await writeFile(
      join(projectRoot, '.claude', 'rules', 'myRule.md'),
      `${RULE_FM('myRule')}Project-specific.`,
    );
    const rules = await loadRulesForStep(['myRule'], pluginRoot, projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('myRule');
  });

  it('plugin rules come before project rules for same name', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'coding.md'),
      `${RULE_FM('coding')}Plugin body.`,
    );
    await writeFile(
      join(projectRoot, '.claude', 'rules', 'coding.md'),
      `${RULE_FM('coding')}Project body.`,
    );
    const rules = await loadRulesForStep(['coding'], pluginRoot, projectRoot);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.body).toContain('Plugin body.');
    expect(rules[1]!.body).toContain('Project body.');
  });

  it('finds rules in subdirectories', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'ewh', 'coding.md'),
      `${RULE_FM('coding')}Subdir body.`,
    );
    const rules = await loadRulesForStep(['coding'], pluginRoot, projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.body).toContain('Subdir body.');
  });

  it('concatenates multiple named rules in order', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'coding.md'),
      `${RULE_FM('coding')}Coding rule.`,
    );
    await writeFile(
      join(pluginRoot, 'rules', 'review.md'),
      `${RULE_FM('review')}Review rule.`,
    );
    const rules = await loadRulesForStep(
      ['coding', 'review'],
      pluginRoot,
      projectRoot,
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]!.name).toBe('coding');
    expect(rules[1]!.name).toBe('review');
  });

  it('parses all frontmatter fields (severity, scope, inject_into, verify)', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'full.md'),
      `---\nname: full\ndescription: a full rule\nseverity: critical\nscope: [agent, coder]\ninject_into: [coder]\nverify: "echo ok"\n---\n\nbody.`,
    );
    const rules = await loadRulesForStep(['full'], pluginRoot, projectRoot);
    expect(rules[0]!.severity).toBe('critical');
    expect(rules[0]!.scope).toEqual(['agent', 'coder']);
    expect(rules[0]!.inject_into).toEqual(['coder']);
    expect(rules[0]!.verify).toBe('echo ok');
    expect(rules[0]!.description).toBe('a full rule');
  });

  it('honors verify: null (explicitly null, not missing)', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'nullv.md'),
      `---\nname: nullv\nverify: null\n---\n\nbody.`,
    );
    const rules = await loadRulesForStep(['nullv'], pluginRoot, projectRoot);
    expect(rules[0]!.verify).toBeNull();
  });

  it('leaves optional fields undefined when absent', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'sparse.md'),
      `---\nname: sparse\n---\n\nbody`,
    );
    const rules = await loadRulesForStep(['sparse'], pluginRoot, projectRoot);
    expect(rules[0]!.severity).toBeUndefined();
    expect(rules[0]!.scope).toBeUndefined();
    expect(rules[0]!.inject_into).toBeUndefined();
    expect(rules[0]!.verify).toBeUndefined();
    expect(rules[0]!.description).toBeUndefined();
  });

  it('handles rule file with no frontmatter', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'bare.md'),
      `No frontmatter at all.`,
    );
    const rules = await loadRulesForStep(['bare'], pluginRoot, projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('');
    expect(rules[0]!.body).toBe('No frontmatter at all.');
  });

  it('drops non-string scope entries', async () => {
    await writeFile(
      join(pluginRoot, 'rules', 'mixed.md'),
      `---\nname: mixed\nscope: ["agent", 42]\n---\n\nbody`,
    );
    const rules = await loadRulesForStep(['mixed'], pluginRoot, projectRoot);
    expect(rules[0]!.scope).toEqual(['agent']);
  });
});
