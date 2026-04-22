import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadContract,
  resolveContractPath,
} from '../src/workflow/contract-loader.js';
import type { WorkflowContract } from '../src/workflow/contract.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-contract-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const goodContract: WorkflowContract = {
  name: 'add-feature',
  description: 'Plan, implement, review.',
  steps: [
    {
      name: 'plan',
      agent: 'planner',
      description: 'Design the feature.',
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
      description: 'Implement it.',
      gate: 'auto',
      produces: ['.ewh-artifacts/code-output.md'],
      context: [
        { type: 'rule', ref: 'coding' },
        { type: 'artifact', ref: '.ewh-artifacts/plan.md' },
        { type: 'file', ref: 'README.md' },
      ],
      requires: [{ file_exists: '.ewh-artifacts/plan.md' }],
      chunked: false,
      script: null,
      script_fallback: 'gate',
    },
  ],
};

async function writeJson(name: string, data: unknown): Promise<string> {
  const path = join(tmpDir, `${name}.json`);
  await fs.writeFile(path, JSON.stringify(data), 'utf8');
  return path;
}

describe('loadContract', () => {
  it('loads a well-formed contract', async () => {
    const path = await writeJson('ok', goodContract);
    const loaded = await loadContract(path);
    expect(loaded.name).toBe('add-feature');
    expect(loaded.steps).toHaveLength(2);
    expect(loaded.steps[1]!.context).toHaveLength(3);
    expect(loaded.steps[1]!.context[0]).toEqual({ type: 'rule', ref: 'coding' });
    expect(loaded.steps[1]!.requires[0]).toEqual({
      file_exists: '.ewh-artifacts/plan.md',
    });
  });

  it('rejects bad top-level shape (missing name)', async () => {
    const path = await writeJson('bad-top', {
      description: 'x',
      steps: [],
    });
    await expect(loadContract(path)).rejects.toThrow(
      /'name' must be a non-empty string/,
    );
  });

  it('rejects bad step field type (chunked is not boolean)', async () => {
    const bad = {
      ...goodContract,
      steps: [
        {
          ...goodContract.steps[0],
          chunked: 'nope',
        },
      ],
    };
    const path = await writeJson('bad-step', bad);
    await expect(loadContract(path)).rejects.toThrow(
      /'chunked' must be a boolean/,
    );
  });

  it('rejects bad context entry type', async () => {
    const bad = {
      ...goodContract,
      steps: [
        {
          ...goodContract.steps[0],
          context: [{ type: 'bogus', ref: 'x' }],
        },
      ],
    };
    const path = await writeJson('bad-ctx', bad);
    await expect(loadContract(path)).rejects.toThrow(
      /'type' must be 'rule', 'artifact', or 'file'/,
    );
  });

  it('rejects malformed JSON with a readable error', async () => {
    const path = join(tmpDir, 'junk.json');
    await fs.writeFile(path, '{ not json', 'utf8');
    await expect(loadContract(path)).rejects.toThrow(/is not valid JSON/);
  });
});

describe('resolveContractPath', () => {
  it('returns the path when the contract exists', async () => {
    const dir = join(tmpDir, '.claude', 'ewh-workflows');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'hello.json'), '{}', 'utf8');
    const resolved = await resolveContractPath(tmpDir, 'hello');
    expect(resolved).toBe(join(dir, 'hello.json'));
  });

  it('returns null when absent', async () => {
    const resolved = await resolveContractPath(tmpDir, 'missing');
    expect(resolved).toBeNull();
  });
});
