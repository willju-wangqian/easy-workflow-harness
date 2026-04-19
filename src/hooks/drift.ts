import type { TurnLogEntry } from './tool-use-log.js';

const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS',
  'mcp__serena__find_symbol', 'mcp__serena__get_symbols_overview',
  'mcp__serena__find_referencing_symbols',
]);

export type DriftResult = 'ok' | { kind: 'mismatch'; expected: string; actual: string };

export function compareDrift(
  expectedTool: string | undefined,
  entries: TurnLogEntry[],
): DriftResult {
  if (expectedTool === undefined) return 'ok';

  const primary = entries.find(
    (e) =>
      !READ_ONLY_TOOLS.has(e.tool) &&
      (e.event === 'SubagentStart' || e.event === 'PostToolUse'),
  );

  if (!primary) return 'ok';

  if (primary.tool === expectedTool) return 'ok';

  return { kind: 'mismatch', expected: expectedTool, actual: primary.tool };
}
