import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, resolveWorkflowPath } from '../src/workflow/parse.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-parse-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(path: string, content: string) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

describe('resolveWorkflowPath', () => {
  it('prefers project override over plugin copy', async () => {
    const projectPath = join(tmpDir, 'proj', '.claude', 'workflows', 'x.md');
    const pluginPath = join(tmpDir, 'plug', 'workflows', 'x.md');
    await write(projectPath, 'proj');
    await write(pluginPath, 'plug');
    const resolved = await resolveWorkflowPath(
      join(tmpDir, 'proj'),
      join(tmpDir, 'plug'),
      'x',
    );
    expect(resolved).toBe(projectPath);
  });

  it('falls back to plugin copy when no project override', async () => {
    const pluginPath = join(tmpDir, 'plug', 'workflows', 'x.md');
    await write(pluginPath, 'plug');
    const resolved = await resolveWorkflowPath(
      join(tmpDir, 'proj'),
      join(tmpDir, 'plug'),
      'x',
    );
    expect(resolved).toBe(pluginPath);
  });

  it('throws when workflow not found anywhere', async () => {
    await expect(
      resolveWorkflowPath(join(tmpDir, 'p'), join(tmpDir, 'pl'), 'nope'),
    ).rejects.toThrow(/workflow 'nope' not found/);
  });
});

describe('loadWorkflow', () => {
  const makePath = () => join(tmpDir, 'wf.md');

  it('parses name, description, trigger, and steps', async () => {
    await write(
      makePath(),
      `---\nname: hello\ndescription: Say hi\ntrigger: /hello\n---\n\n## Steps\n\n- name: greet\n  gate: auto\n  agent: coder\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.name).toBe('hello');
    expect(wf.description).toBe('Say hi');
    expect(wf.trigger).toBe('/hello');
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]!.name).toBe('greet');
    expect(wf.steps[0]!.gate).toBe('auto');
    expect(wf.steps[0]!.agent).toBe('coder');
  });

  it('defaults gate to auto when absent or unknown', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n- name: b\n  gate: weird\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.gate).toBe('auto');
    expect(wf.steps[1]!.gate).toBe('auto');
  });

  it('keeps gate=structural when specified', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  gate: structural\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.gate).toBe('structural');
  });

  it('parses all optional step fields', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  description: desc\n  message: msg\n  rules: [r1, r2]\n  reads: [file1.md]\n  artifact: out.md\n  requires: { prior_step: plan }\n  chunked: true\n  script: ./run.sh\n  script_fallback: auto\n  context:\n    - step: plan\n      detail: full\n    - step: code\n      detail: raw\n    - step: test\n`,
    );
    const wf = await loadWorkflow(makePath());
    const step = wf.steps[0]!;
    expect(step.description).toBe('desc');
    expect(step.message).toBe('msg');
    expect(step.rules).toEqual(['r1', 'r2']);
    expect(step.reads).toEqual(['file1.md']);
    expect(step.artifact).toBe('out.md');
    expect(step.chunked).toBe(true);
    expect(step.script).toBe('./run.sh');
    expect(step.script_fallback).toBe('auto');
    expect(step.context).toEqual([
      { step: 'plan', detail: 'full' },
      { step: 'code', detail: 'raw' },
      { step: 'test', detail: 'summary' },
    ]);
    expect(step.requires).toEqual({ prior_step: 'plan' });
  });

  it('maps script_fallback: gate correctly', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  script_fallback: gate\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.script_fallback).toBe('gate');
  });

  it('leaves script_fallback undefined on unknown value', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  script_fallback: unknown\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.script_fallback).toBeUndefined();
  });

  it('ignores invalid rules/reads (non-string items)', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  rules: [1, 2, "ok"]\n  reads: []\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.rules).toEqual(['ok']);
    // empty-after-filter becomes undefined
    expect(wf.steps[0]!.reads).toBeUndefined();
  });

  it('leaves rules undefined when not an array', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  rules: "notalist"\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.rules).toBeUndefined();
  });

  it('handles context with invalid entries (filters them out)', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  context:\n    - step: ok\n      detail: summary\n    - notastring\n    - step: 42\n    - step: good\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.context).toEqual([
      { step: 'ok', detail: 'summary' },
      { step: 'good', detail: 'summary' },
    ]);
  });

  it('leaves context undefined when not a list or empty', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n  context: "bad"\n- name: b\n  context: []\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps[0]!.context).toBeUndefined();
    expect(wf.steps[1]!.context).toBeUndefined();
  });

  it('throws when frontmatter missing', async () => {
    await write(makePath(), `## Steps\n\n- name: a\n`);
    await expect(loadWorkflow(makePath())).rejects.toThrow(/missing YAML frontmatter/);
  });

  it('throws when frontmatter unterminated', async () => {
    await write(makePath(), `---\nname: wf\nno close\n`);
    await expect(loadWorkflow(makePath())).rejects.toThrow(/unterminated YAML frontmatter/);
  });

  it('throws when frontmatter has no name', async () => {
    await write(
      makePath(),
      `---\ndescription: no name\n---\n\n## Steps\n\n- name: a\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/name must be a non-empty string/);
  });

  it('throws when Steps section missing', async () => {
    await write(makePath(), `---\nname: wf\n---\n\n## Other\n\n- name: a\n`);
    await expect(loadWorkflow(makePath())).rejects.toThrow(/missing '## Steps' section/);
  });

  it('throws when Steps section is not a YAML list', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\nnot: a list\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/YAML sequence of step mappings/);
  });

  it('throws on invalid YAML in Steps section', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n    bad:\n  :  : indentation\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/Steps' section is not valid YAML/);
  });

  it('throws when step is not a mapping', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- just a string\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/step #1: must be a YAML mapping/);
  });

  it('throws when step has no name', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- description: anonymous\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/step #1: name must be a non-empty string/);
  });

  it('throws when step list is empty', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n[]\n`,
    );
    await expect(loadWorkflow(makePath())).rejects.toThrow(/has no steps/);
  });

  it('stops at the next ## heading when scanning Steps section', async () => {
    await write(
      makePath(),
      `---\nname: wf\n---\n\n## Steps\n\n- name: a\n\n## Notes\n\nblah\n`,
    );
    const wf = await loadWorkflow(makePath());
    expect(wf.steps).toHaveLength(1);
  });
});
