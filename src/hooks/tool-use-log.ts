import { promises as fs } from 'node:fs';

export type TurnLogEntry =
  | { event: 'SubagentStart'; ts: string; tool: 'Agent'; subagent_type?: string; description?: string }
  | { event: 'SubagentStop'; ts: string; tool: 'Agent' }
  | { event: 'PostToolUse'; ts: string; tool: string; input?: unknown };

export async function readTurnLogSince(
  logPath: string,
  offset: number,
): Promise<{ entries: TurnLogEntry[]; newOffset: number }> {
  let buf: Buffer;
  try {
    const fh = await fs.open(logPath, 'r');
    try {
      const stat = await fh.stat();
      const size = stat.size;
      if (size <= offset) {
        return { entries: [], newOffset: offset };
      }
      const readLen = size - offset;
      buf = Buffer.allocUnsafe(readLen);
      await fh.read(buf, 0, readLen, offset);
      const newOffset = size;
      const text = buf.toString('utf8');
      const entries: TurnLogEntry[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as TurnLogEntry;
          entries.push(parsed);
        } catch {
          // skip malformed lines silently
        }
      }
      return { entries, newOffset };
    } finally {
      await fh.close();
    }
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') {
      return { entries: [], newOffset: offset };
    }
    throw err;
  }
}
