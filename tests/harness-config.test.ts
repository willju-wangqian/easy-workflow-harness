import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHarnessConfig } from '../src/workflow/harness-config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-hc-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadHarnessConfig', () => {
  it('returns undefined when CLAUDE.md is missing', async () => {
    const result = await loadHarnessConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when Harness Config section is absent', async () => {
    await fs.writeFile(
      join(tmpDir, 'CLAUDE.md'),
      '# Project\n\n## Other Section\n\nText here.\n',
      'utf8',
    );
    const result = await loadHarnessConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('extracts the Harness Config section body', async () => {
    await fs.writeFile(
      join(tmpDir, 'CLAUDE.md'),
      '# Title\n\n## Intro\n\nIntro body.\n\n## Harness Config\n\n- Language: typescript\n- Test command: npm test\n\n## Another\n\nmore\n',
      'utf8',
    );
    const result = await loadHarnessConfig(tmpDir);
    expect(result).toBeDefined();
    expect(result).toContain('Language: typescript');
    expect(result).toContain('Test command: npm test');
    expect(result).not.toContain('Another');
  });

  it('extracts section that runs to EOF', async () => {
    await fs.writeFile(
      join(tmpDir, 'CLAUDE.md'),
      '## Harness Config\n\nlast section — no more headings.\n',
      'utf8',
    );
    const result = await loadHarnessConfig(tmpDir);
    expect(result).toBe('last section — no more headings.');
  });

  it('returns undefined when section is present but empty/whitespace', async () => {
    await fs.writeFile(
      join(tmpDir, 'CLAUDE.md'),
      '## Harness Config\n\n\n\n## Next\n\nhi',
      'utf8',
    );
    const result = await loadHarnessConfig(tmpDir);
    expect(result).toBeUndefined();
  });
});
