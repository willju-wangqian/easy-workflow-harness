/**
 * Split work items into fixed-size chunks for the split phase (§6a equivalent).
 *
 * Default size 30 matches the CLAUDE.md contract: "splits into 30-item
 * parallel chunks and merges results."
 */

export const DEFAULT_SPLIT_SIZE = 30;

export function splitItems(
  items: string[],
  size: number = DEFAULT_SPLIT_SIZE,
): string[][] {
  if (size <= 0) throw new Error('split size must be > 0');
  if (items.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
