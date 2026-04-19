/**
 * Extract the `## Harness Config` section from the project's CLAUDE.md.
 * Returns undefined if the file is missing or the section is absent.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export async function loadHarnessConfig(
  projectRoot: string,
): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');
  } catch {
    return undefined;
  }
  return extractSection(content, 'Harness Config');
}

function extractSection(content: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'm');
  const m = content.match(re);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const rel = content.slice(start).search(/^##\s+\S/m);
  const section =
    rel === -1 ? content.slice(start) : content.slice(start, start + rel);
  return section.trim() || undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
