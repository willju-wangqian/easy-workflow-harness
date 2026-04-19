import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgent } from '../src/workflow/agent-loader.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-agent-test-'));
  pluginRoot = join(tmpDir, 'plug');
  projectRoot = join(tmpDir, 'proj');
  await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
  await fs.mkdir(join(projectRoot, '.claude', 'agents'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadAgent', () => {
  it('loads a plugin agent with all frontmatter fields', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      `---
name: coder
description: Writes code
model: sonnet
tools: [Read, Write, Edit]
maxTurns: 20
incremental: true
---

Agent body goes here.
`,
      'utf8',
    );
    const agent = await loadAgent('coder', pluginRoot, projectRoot);
    expect(agent.name).toBe('coder');
    expect(agent.description).toBe('Writes code');
    expect(agent.model).toBe('sonnet');
    expect(agent.tools).toEqual(['Read', 'Write', 'Edit']);
    expect(agent.maxTurns).toBe(20);
    expect(agent.incremental).toBe(true);
    expect(agent.body).toContain('Agent body goes here.');
  });

  it('prefers project override over plugin agent', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      `---\nname: coder\nmodel: sonnet\n---\n\nplugin`,
      'utf8',
    );
    await fs.writeFile(
      join(projectRoot, '.claude', 'agents', 'coder.md'),
      `---\nname: coder\nmodel: haiku\n---\n\nproject`,
      'utf8',
    );
    const agent = await loadAgent('coder', pluginRoot, projectRoot);
    expect(agent.model).toBe('haiku');
    expect(agent.body).toContain('project');
  });

  it('throws when the agent is absent in both locations', async () => {
    await expect(loadAgent('missing', pluginRoot, projectRoot)).rejects.toThrow(
      /agent 'missing' not found/,
    );
  });

  it('leaves optional fields undefined when not in frontmatter', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'sparse.md'),
      `---\nname: sparse\n---\n\nMinimal body.`,
      'utf8',
    );
    const agent = await loadAgent('sparse', pluginRoot, projectRoot);
    expect(agent.description).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.tools).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.incremental).toBeUndefined();
  });

  it('drops non-string tools entries', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'mixedtools.md'),
      `---\nname: mixedtools\ntools: ["Read", 3, true, "Write"]\n---\n\nbody`,
      'utf8',
    );
    const agent = await loadAgent('mixedtools', pluginRoot, projectRoot);
    expect(agent.tools).toEqual(['Read', 'Write']);
  });

  it('treats an empty tools list as undefined', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'notools.md'),
      `---\nname: notools\ntools: []\n---\n\nbody`,
      'utf8',
    );
    const agent = await loadAgent('notools', pluginRoot, projectRoot);
    expect(agent.tools).toBeUndefined();
  });

  it('handles missing frontmatter gracefully (empty name)', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'bare.md'),
      `No frontmatter here.`,
      'utf8',
    );
    const agent = await loadAgent('bare', pluginRoot, projectRoot);
    expect(agent.name).toBe('');
    expect(agent.body).toBe('No frontmatter here.');
  });

  it('handles unterminated frontmatter (treats whole body as body)', async () => {
    await fs.writeFile(
      join(pluginRoot, 'agents', 'badfm.md'),
      `---\nname: badfm\nno termination here`,
      'utf8',
    );
    const agent = await loadAgent('badfm', pluginRoot, projectRoot);
    expect(agent.name).toBe('');
    expect(agent.body).toContain('name: badfm');
  });
});
