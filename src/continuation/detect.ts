/**
 * Detect list items from a partial agent output.
 *
 * Used by the split phase to identify remaining work units when an agent
 * ran out of turns and the AGENT_COMPLETE sentinel is absent.
 * Matches numbered lists (1. / 1) ) and bullet lists (- / * / •).
 */

const LIST_ITEM_RE = /^\s*(?:\d+[.)]\s+|[-*•]\s+)(.+)$/;

export function detectListItems(partial: string): string[] {
  const items: string[] = [];
  for (const line of partial.split('\n')) {
    const m = line.match(LIST_ITEM_RE);
    if (m) items.push(m[1]!.trim());
  }
  return items;
}
