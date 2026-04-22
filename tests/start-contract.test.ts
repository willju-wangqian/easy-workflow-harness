/**
 * `ewh start` loads the project contract from `.claude/ewh-workflows/<name>.json`.
 * Plugin `workflows/` is templates-only after Session 6; a project without
 * a contract gets a clean error directing them to `migrate` or `design`.
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

describe('workflow resolution: JSON contract only', () => {
  it('loads project JSON contract and identifies the path in stderr', async () => {
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

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('JSON contract');

    const stateDir = join(projectRoot, '.ewh-artifacts');
    const entries = await fs.readdir(stateDir);
    const runDir = entries.find((e) => e.startsWith('run-'))!;
    const stateJson = JSON.parse(
      await fs.readFile(join(stateDir, runDir, 'state.json'), 'utf8'),
    );
    expect(stateJson.steps[0].name).toBe('json-step');

    const promptPath = join(stateDir, runDir, 'step-0-prompt.md');
    const prompt = await fs.readFile(promptPath, 'utf8');
    expect(prompt).toContain('from-json.md');
  });

  it('errors cleanly when no contract exists, directing to migrate/design', async () => {
    // Plugin has a YAML template, but the runtime no longer falls back to it.
    await writeFile(
      join(pluginRoot, 'workflows', 'yamlonly.md'),
      `---\nname: yamlonly\n---\n\n## Steps\n\n- name: go\n  gate: auto\n  agent: coder\n  reads: [yaml.md]\n`,
    );

    await expect(
      runStart({ projectRoot, pluginRoot, rawArgv: 'yamlonly' }),
    ).rejects.toThrow(/No contract found at \.claude\/ewh-workflows\/yamlonly\.json/);
    await expect(
      runStart({ projectRoot, pluginRoot, rawArgv: 'yamlonly' }),
    ).rejects.toThrow(/\/ewh:doit migrate/);
    await expect(
      runStart({ projectRoot, pluginRoot, rawArgv: 'yamlonly' }),
    ).rejects.toThrow(/\/ewh:doit design yamlonly/);
  });
});
