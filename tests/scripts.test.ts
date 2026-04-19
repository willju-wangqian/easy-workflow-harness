import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashStep } from '../src/scripts/hash.js';
import {
  scriptCachePath,
  hashCachePath,
  readCachedScript,
  writeCachedScript,
  deleteCachedScript,
  listCachedScripts,
} from '../src/scripts/cache.js';
import { isScriptable, evaluateScript } from '../src/scripts/evaluate.js';
import type { Step } from '../src/state/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-scripts-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeStep(overrides?: Partial<Step>): Step {
  return {
    name: 'code',
    gate: 'auto',
    description: 'Write code.',
    state: { phase: 'pending' },
    ...overrides,
  };
}

// ── hash ────────────────────────────────────────────────────────────────────

describe('hashStep', () => {
  it('returns the same hash for the same step definition', () => {
    const s = makeStep({ rules: ['lint', 'types'] });
    expect(hashStep(s)).toBe(hashStep(s));
  });

  it('returns a different hash when description changes', () => {
    const a = makeStep({ description: 'Write code.' });
    const b = makeStep({ description: 'Write tests.' });
    expect(hashStep(a)).not.toBe(hashStep(b));
  });

  it('returns a different hash when rules change', () => {
    const a = makeStep({ rules: ['lint'] });
    const b = makeStep({ rules: ['lint', 'types'] });
    expect(hashStep(a)).not.toBe(hashStep(b));
  });

  it('rules order does not affect hash (sorted)', () => {
    const a = makeStep({ rules: ['lint', 'types'] });
    const b = makeStep({ rules: ['types', 'lint'] });
    expect(hashStep(a)).toBe(hashStep(b));
  });

  it('returns a 64-char hex string', () => {
    expect(hashStep(makeStep())).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── cache paths ─────────────────────────────────────────────────────────────

describe('scriptCachePath / hashCachePath', () => {
  it('scriptCachePath returns absolute path ending in .sh', () => {
    const p = scriptCachePath(tmpDir, 'add-feature', 'code');
    expect(p).toMatch(/\.sh$/);
    expect(p).toMatch(/add-feature/);
    expect(p).toMatch(/code/);
    expect(p.startsWith('/')).toBe(true);
  });

  it('hashCachePath returns absolute path ending in .hash', () => {
    const p = hashCachePath(tmpDir, 'add-feature', 'code');
    expect(p).toMatch(/\.hash$/);
  });
});

// ── readCachedScript ─────────────────────────────────────────────────────────

describe('readCachedScript', () => {
  it('returns null when no cached script', async () => {
    const result = await readCachedScript(tmpDir, 'wf', 'step');
    expect(result).toBeNull();
  });

  it('returns path and storedHash when script and hash file exist', async () => {
    await writeCachedScript(tmpDir, 'wf', 'step', '#!/bin/bash\nexit 0\n', 'abc123');
    const result = await readCachedScript(tmpDir, 'wf', 'step');
    expect(result).not.toBeNull();
    expect(result!.storedHash).toBe('abc123');
    expect(result!.path).toMatch(/step\.sh$/);
  });

  it('returns storedHash=null when .hash file missing', async () => {
    const path = scriptCachePath(tmpDir, 'wf', 'step');
    await fs.mkdir(join(tmpDir, '.claude', 'ewh-scripts', 'wf'), { recursive: true });
    await fs.writeFile(path, '#!/bin/bash\n', 'utf8');
    const result = await readCachedScript(tmpDir, 'wf', 'step');
    expect(result).not.toBeNull();
    expect(result!.storedHash).toBeNull();
  });
});

// ── writeCachedScript ────────────────────────────────────────────────────────

describe('writeCachedScript', () => {
  it('writes script and hash files', async () => {
    await writeCachedScript(tmpDir, 'wf', 'step', '#!/bin/bash\nexit 0\n', 'hash42');
    const script = await fs.readFile(scriptCachePath(tmpDir, 'wf', 'step'), 'utf8');
    const hash = await fs.readFile(hashCachePath(tmpDir, 'wf', 'step'), 'utf8');
    expect(script).toBe('#!/bin/bash\nexit 0\n');
    expect(hash.trim()).toBe('hash42');
  });

  it('creates parent directories automatically', async () => {
    await writeCachedScript(tmpDir, 'deep/workflow', 'my-step', 'echo hi', 'h');
    const result = await readCachedScript(tmpDir, 'deep/workflow', 'my-step');
    expect(result).not.toBeNull();
  });
});

// ── deleteCachedScript ───────────────────────────────────────────────────────

describe('deleteCachedScript', () => {
  it('removes script and hash files', async () => {
    await writeCachedScript(tmpDir, 'wf', 'step', 'body', 'h');
    await deleteCachedScript(tmpDir, 'wf', 'step');
    const result = await readCachedScript(tmpDir, 'wf', 'step');
    expect(result).toBeNull();
  });

  it('is a no-op when files do not exist', async () => {
    await expect(deleteCachedScript(tmpDir, 'wf', 'missing')).resolves.not.toThrow();
  });
});

// ── listCachedScripts ────────────────────────────────────────────────────────

describe('listCachedScripts', () => {
  it('returns empty array when no scripts', async () => {
    expect(await listCachedScripts(tmpDir, 'wf')).toEqual([]);
  });

  it('returns entry for each .sh file', async () => {
    await writeCachedScript(tmpDir, 'wf', 'alpha', 'body', 'h');
    await writeCachedScript(tmpDir, 'wf', 'beta', 'body', 'h');
    const list = await listCachedScripts(tmpDir, 'wf');
    const names = list.map((e) => e.stepName).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('does not include .hash files in results', async () => {
    await writeCachedScript(tmpDir, 'wf', 'step', 'body', 'h');
    const list = await listCachedScripts(tmpDir, 'wf');
    expect(list.every((e) => !e.stepName.endsWith('.hash'))).toBe(true);
  });
});

// ── isScriptable ─────────────────────────────────────────────────────────────

describe('isScriptable', () => {
  it('returns true for an agent-only step with no reads/artifact/context', () => {
    expect(isScriptable(makeStep({ agent: 'coder' }))).toBe(true);
  });

  it('returns false when step has no agent', () => {
    expect(isScriptable(makeStep())).toBe(false);
  });

  it('returns false when step has reads', () => {
    expect(isScriptable(makeStep({ agent: 'coder', reads: ['x.md'] }))).toBe(false);
  });

  it('returns false when step has artifact', () => {
    expect(isScriptable(makeStep({ agent: 'coder', artifact: 'out.txt' }))).toBe(false);
  });

  it('returns false when step has context refs', () => {
    expect(
      isScriptable(makeStep({ agent: 'coder', context: [{ step: 'prev', detail: 'summary' }] })),
    ).toBe(false);
  });

  it('returns false when step is chunked', () => {
    expect(isScriptable(makeStep({ agent: 'coder', chunked: true }))).toBe(false);
  });
});

// ── evaluateScript ───────────────────────────────────────────────────────────

describe('evaluateScript', () => {
  it('returns explicit when step has script: field', async () => {
    const scriptPath = join(tmpDir, 'my.sh');
    await fs.writeFile(scriptPath, '#!/bin/bash\n', 'utf8');
    const step = makeStep({ script: scriptPath });
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('explicit');
    if (result.kind === 'explicit') expect(result.scriptPath).toBe(scriptPath);
  });

  it('resolves relative script: paths against projectRoot', async () => {
    const scriptPath = join(tmpDir, 'scripts', 'mine.sh');
    await fs.mkdir(join(tmpDir, 'scripts'), { recursive: true });
    await fs.writeFile(scriptPath, '#!/bin/bash\n', 'utf8');
    const step = makeStep({ script: 'scripts/mine.sh' });
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('explicit');
    if (result.kind === 'explicit') expect(result.scriptPath).toBe(scriptPath);
  });

  it('returns cached (not stale) when hash matches', async () => {
    const step = makeStep({ agent: 'coder' });
    const hash = hashStep(step);
    await writeCachedScript(tmpDir, 'wf', 'code', 'body', hash);
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('cached');
    if (result.kind === 'cached') expect(result.stale).toBe(false);
  });

  it('returns cached (stale) when hash differs', async () => {
    const step = makeStep({ agent: 'coder' });
    await writeCachedScript(tmpDir, 'wf', 'code', 'body', 'old-hash');
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('cached');
    if (result.kind === 'cached') expect(result.stale).toBe(true);
  });

  it('returns propose when no cache and step is scriptable', async () => {
    const step = makeStep({ agent: 'coder' });
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('propose');
  });

  it('returns agent when no cache and step is not scriptable', async () => {
    const step = makeStep({ agent: 'coder', reads: ['spec.md'] });
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('agent');
  });

  it('explicit takes priority over cached script', async () => {
    const scriptPath = join(tmpDir, 'explicit.sh');
    await fs.writeFile(scriptPath, '#!/bin/bash\n', 'utf8');
    // Also write a cached script
    await writeCachedScript(tmpDir, 'wf', 'code', 'body', 'h');
    const step = makeStep({ script: scriptPath });
    const result = await evaluateScript(tmpDir, 'wf', step);
    expect(result.kind).toBe('explicit');
  });
});
