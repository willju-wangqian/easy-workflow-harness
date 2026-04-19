/**
 * Sentinel detection — pure function, no I/O.
 *
 * The AGENT_COMPLETE sentinel must appear as a standalone line (trimmed)
 * at the very end of the agent's output. We scan the last `scanLines`
 * lines so benign trailing whitespace doesn't defeat the check.
 */

export const SENTINEL = 'AGENT_COMPLETE';
const DEFAULT_SCAN_LINES = 10;

export function checkSentinel(
  content: string,
  scanLines: number = DEFAULT_SCAN_LINES,
): boolean {
  const lines = content.split('\n');
  const tail = lines.slice(-scanLines);
  return tail.some((l) => l.trim() === SENTINEL);
}
