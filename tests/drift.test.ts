import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareDrift } from '../src/hooks/drift.js';
import { readTurnLogSince, type TurnLogEntry } from '../src/hooks/tool-use-log.js';
import { markActive, clearActive } from '../src/state/store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-drift-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── compareDrift ──────────────────────────────────────────────────────────────

describe('compareDrift', () => {
  it('returns ok when expectedTool is undefined', () => {
    expect(compareDrift(undefined, [])).toBe('ok');
  });

  it('returns ok when entries is empty', () => {
    expect(compareDrift('Agent', [])).toBe('ok');
  });

  it('returns ok when SubagentStart matches expected tool', () => {
    const entries: TurnLogEntry[] = [
      { event: 'SubagentStart', ts: '2024-01-01T00:00:00Z', tool: 'Agent' },
    ];
    expect(compareDrift('Agent', entries)).toBe('ok');
  });

  it('returns mismatch when PostToolUse tool differs from expected', () => {
    const entries: TurnLogEntry[] = [
      { event: 'PostToolUse', ts: '2024-01-01T00:00:00Z', tool: 'Bash' },
    ];
    expect(compareDrift('Agent', entries)).toEqual({
      kind: 'mismatch',
      expected: 'Agent',
      actual: 'Bash',
    });
  });

  it('skips read-only tools and matches the next non-read-only entry', () => {
    const entries: TurnLogEntry[] = [
      { event: 'PostToolUse', ts: '2024-01-01T00:00:00Z', tool: 'Read' },
      { event: 'SubagentStart', ts: '2024-01-01T00:00:01Z', tool: 'Agent' },
    ];
    expect(compareDrift('Agent', entries)).toBe('ok');
  });

  it('returns ok when all entries are read-only (no primary found)', () => {
    const entries: TurnLogEntry[] = [
      { event: 'PostToolUse', ts: '2024-01-01T00:00:00Z', tool: 'Read' },
    ];
    expect(compareDrift('Bash', entries)).toBe('ok');
  });
});

// ── readTurnLogSince ──────────────────────────────────────────────────────────

describe('readTurnLogSince', () => {
  it('returns empty entries and offset 0 when file does not exist', async () => {
    const result = await readTurnLogSince(join(tmpDir, 'nonexistent.jsonl'), 0);
    expect(result).toEqual({ entries: [], newOffset: 0 });
  });

  it('reads all entries from offset 0', async () => {
    const logPath = join(tmpDir, 'turn-log.jsonl');
    const entry1: TurnLogEntry = { event: 'SubagentStart', ts: '2024-01-01T00:00:00Z', tool: 'Agent' };
    const entry2: TurnLogEntry = { event: 'PostToolUse', ts: '2024-01-01T00:00:01Z', tool: 'Bash' };
    await fs.writeFile(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf8');

    const result = await readTurnLogSince(logPath, 0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual(entry1);
    expect(result.entries[1]).toEqual(entry2);
    expect(result.newOffset).toBeGreaterThan(0);
  });

  it('reads only new entries from a non-zero offset', async () => {
    const logPath = join(tmpDir, 'turn-log.jsonl');
    const entry1: TurnLogEntry = { event: 'SubagentStart', ts: '2024-01-01T00:00:00Z', tool: 'Agent' };
    const line1 = JSON.stringify(entry1) + '\n';
    await fs.writeFile(logPath, line1, 'utf8');

    // Read first entry, note offset
    const first = await readTurnLogSince(logPath, 0);
    expect(first.entries).toHaveLength(1);
    const offset = first.newOffset;

    // Append second entry
    const entry2: TurnLogEntry = { event: 'SubagentStop', ts: '2024-01-01T00:00:01Z', tool: 'Agent' };
    await fs.appendFile(logPath, JSON.stringify(entry2) + '\n', 'utf8');

    // Read from saved offset — should only get entry2
    const second = await readTurnLogSince(logPath, offset);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toEqual(entry2);
    expect(second.newOffset).toBeGreaterThan(offset);
  });

  it('skips malformed JSON lines silently', async () => {
    const logPath = join(tmpDir, 'turn-log.jsonl');
    const entry: TurnLogEntry = { event: 'SubagentStop', ts: '2024-01-01T00:00:00Z', tool: 'Agent' };
    await fs.writeFile(
      logPath,
      'not-json\n' + JSON.stringify(entry) + '\n{broken\n',
      'utf8',
    );

    const result = await readTurnLogSince(logPath, 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(entry);
  });
});

// ── ACTIVE marker lifecycle ───────────────────────────────────────────────────

describe('ACTIVE marker lifecycle', () => {
  it('markActive creates the ACTIVE file', async () => {
    const id = 'test01';
    await markActive(tmpDir, id);
    const activePath = join(tmpDir, '.ewh-artifacts', `run-${id}`, 'ACTIVE');
    const stat = await fs.stat(activePath);
    expect(stat.isFile()).toBe(true);
  });

  it('clearActive removes the ACTIVE file', async () => {
    const id = 'test02';
    await markActive(tmpDir, id);
    await clearActive(tmpDir, id);
    const activePath = join(tmpDir, '.ewh-artifacts', `run-${id}`, 'ACTIVE');
    await expect(fs.stat(activePath)).rejects.toThrow();
  });

  it('clearActive is idempotent (no error if file already removed)', async () => {
    const id = 'test03';
    await markActive(tmpDir, id);
    await clearActive(tmpDir, id);
    // Second call should not throw
    await expect(clearActive(tmpDir, id)).resolves.toBeUndefined();
  });
});
