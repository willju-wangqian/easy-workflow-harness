/**
 * Session 2 coverage: `ewh start` resolves the JSON contract first when
 * present, and falls back to the legacy YAML workflow when it's not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStart } from '../src/commands/start.js';

let tmpDir: string;
let pluginRoot: string;
let projectRoot: string;

async function writeFile(path: string, content: string) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-start-contract-'));
  pluginRoot = join(tmpDir, 'plugin');
  projectRoot = join(tmpDir, 'project');
  await fs.mkdir(join(pluginRoot, 'workflows'), { recursive: true });
  await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, 'agents', 'coder.md'),
    '---\nname: coder\nmodel: haiku\ntools: [Read, Write]\nmaxTurns: 5\n---\n\nCoder body.',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function parseHeader(raw: string) {
  const actionMatch = raw.match(/^ACTION: (\S+)/);
  return { action: actionMatch?.[1] };
}

describe('workflow resolution: JSON contract vs YAML fallback', () => {
  it('JSON contract wins when both JSON and YAML exist for the same name', async () => {
    // Plugin-level YAML says the agent is coder.
    await writeFile(
      join(pluginRoot, 'workflows', 'hello.md'),
      `---\nname: hello\n---\n\n## Steps\n\n- name: yaml-step\n  gate: auto\n  agent: coder\n  reads: [from-yaml.md]\n`,
    );

    // Project-level JSON contract — should win.
    await writeFile(
      join(projectRoot, '.claude', 'ewh-workflows', 'hello.json'),
      JSON.stringify({
        name: 'hello',
        description: 'from json',
        steps: [
          {
            name: 'json-step',
            agent: 'coder',
            description: 'the JSON step',
            gate: 'auto',
            produces: [],
            context: [{ type: 'file', ref: 'from-json.md' }],
            requires: [],
            chunked: false,
            script: null,
            script_fallback: 'gate',
          },
        ],
      }),
    );

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    let out: string;
    try {
      out = await runStart({
        projectRoot,
        pluginRoot,
        rawArgv: 'hello',
      });
    } finally {
      process.stderr.write = origWrite;
    }

    const { action } = parseHeader(out);
    expect(action).toBe('tool-call');

    // Debug log identifies JSON path.
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('JSON contract');

    // The step name should be the JSON step, not the YAML step. Check by
    // inspecting the persisted state.
    const stateDir = join(projectRoot, '.ewh-artifacts');
    const entries = await fs.readdir(stateDir);
    const runDir = entries.find((e) => e.startsWith('run-'))!;
    const stateJson = JSON.parse(
      await fs.readFile(join(stateDir, runDir, 'state.json'), 'utf8'),
    );
    expect(stateJson.steps[0].name).toBe('json-step');

    // Required Reading in the prompt should mention the JSON-declared file,
    // not the YAML-declared one.
    const promptPath = join(stateDir, runDir, 'step-0-prompt.md');
    const prompt = await fs.readFile(promptPath, 'utf8');
    expect(prompt).toContain('from-json.md');
    expect(prompt).not.toContain('from-yaml.md');
  });

  it('falls back to YAML when no JSON contract exists', async () => {
    await writeFile(
      join(pluginRoot, 'workflows', 'yamlonly.md'),
      `---\nname: yamlonly\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [yaml.md]\n`,
    );

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    let out: string;
    try {
      out = await runStart({
        projectRoot,
        pluginRoot,
        rawArgv: 'yamlonly',
      });
    } finally {
      process.stderr.write = origWrite;
    }

    expect(parseHeader(out).action).toBe('tool-call');
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('loaded from YAML');
    expect(stderr).not.toContain('JSON contract');
  });
});
