import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCatalog } from '../src/commands/design-catalog.js';
import type { CatalogEntry } from '../src/commands/design-catalog.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-catalog-test-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');

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

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n## Body\n`;
}

describe('buildCatalog', () => {
  it('returns plugin entries when no project overrides exist', async () => {
    await fs.writeFile(
      join(pluginRoot, 'workflows', 'add-feature.md'),
      frontmatter({ name: 'add-feature', description: 'Add a feature' }),
    );
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      frontmatter({ name: 'coder', description: 'Writes code' }),
    );
    await fs.writeFile(
      join(pluginRoot, 'rules', 'style.md'),
      frontmatter({ name: 'style', description: 'Style rules' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    expect(catalog).toHaveLength(3);

    const wf = catalog.find((e) => e.name === 'add-feature');
    expect(wf).toMatchObject({ type: 'workflow', scope: 'plugin', name: 'add-feature' });

    const ag = catalog.find((e) => e.name === 'coder');
    expect(ag).toMatchObject({ type: 'agent', scope: 'plugin', name: 'coder' });

    const rule = catalog.find((e) => e.name === 'style');
    expect(rule).toMatchObject({ type: 'rule', scope: 'plugin', name: 'style' });
  });

  it('project agent/workflow wins over plugin when same name', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      frontmatter({ name: 'coder', description: 'Plugin coder' }),
    );
    await fs.writeFile(
      join(pluginRoot, 'workflows', 'add-feature.md'),
      frontmatter({ name: 'add-feature', description: 'Plugin workflow' }),
    );
    await fs.writeFile(
      join(projectRoot, '.claude', 'agents', 'coder.md'),
      frontmatter({ name: 'coder', description: 'Project coder override' }),
    );
    await fs.writeFile(
      join(projectRoot, '.claude', 'workflows', 'add-feature.md'),
      frontmatter({ name: 'add-feature', description: 'Project workflow override' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);

    const agents = catalog.filter((e) => e.type === 'agent' && e.name === 'coder');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.scope).toBe('project');
    expect(agents[0]!.description).toBe('Project coder override');

    const workflows = catalog.filter((e) => e.type === 'workflow' && e.name === 'add-feature');
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.scope).toBe('project');
  });

  it('rules concatenate — both plugin and project entries returned', async () => {
    await fs.writeFile(
      join(pluginRoot, 'rules', 'style.md'),
      frontmatter({ name: 'style', description: 'Plugin style' }),
    );
    await fs.writeFile(
      join(projectRoot, '.claude', 'rules', 'style.md'),
      frontmatter({ name: 'style', description: 'Project style supplement' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    const rules = catalog.filter((e) => e.type === 'rule' && e.name === 'style');
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.scope).sort()).toEqual(['plugin', 'project']);
  });

  it('project-only agent with no plugin counterpart is included', async () => {
    await fs.writeFile(
      join(projectRoot, '.claude', 'agents', 'custom.md'),
      frontmatter({ name: 'custom', description: 'Project-only agent' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    const ag = catalog.find((e) => e.name === 'custom');
    expect(ag!).toMatchObject({ type: 'agent', scope: 'project' });
  });

  it('returns empty array when both roots have no artifacts', async () => {
    const catalog = await buildCatalog(projectRoot, pluginRoot);
    expect(catalog).toHaveLength(0);
  });

  it('skips files with no frontmatter or missing name field', async () => {
    await fs.writeFile(join(pluginRoot, 'agents', 'no-fm.md'), '## Just a heading\n\nNo frontmatter.');
    await fs.writeFile(
      join(pluginRoot, 'agents', 'no-name.md'),
      '---\ndescription: Has description but no name\n---\n\nbody',
    );
    await fs.writeFile(
      join(pluginRoot, 'agents', 'valid.md'),
      frontmatter({ name: 'valid', description: 'Valid agent' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.name).toBe('valid');
  });

  it('walks subdirectories recursively for rules', async () => {
    const subDir = join(pluginRoot, 'rules', 'ewh');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      join(subDir, 'nested-rule.md'),
      frontmatter({ name: 'nested-rule', description: 'Nested rule' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    const rule = catalog.find((e) => e.name === 'nested-rule');
    expect(rule).toMatchObject({ type: 'rule', scope: 'plugin' });
  });

  it('returns correct path field relative to scope root', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      frontmatter({ name: 'coder', description: 'Coder' }),
    );

    const catalog = await buildCatalog(projectRoot, pluginRoot);
    const ag = catalog.find((e) => e.name === 'coder');
    expect(ag?.path).toBe('agents/coder.md');
  });
});
