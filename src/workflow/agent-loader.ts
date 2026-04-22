/**
 * Agent loader for Phase 2.
 *
 * Resolution order (per CLAUDE.md §Architecture):
 *   1. `<projectRoot>/.claude/agents/<name>.md`  (project override)
 *   2. `<pluginRoot>/agents/<name>.md`            (plugin default)
 *
 * `extends: ewh:<name>` in frontmatter is recognised but deferred —
 * no existing agent uses it, so for Phase 2 we load the file as-is
 * and ignore the extends field. Phase 3+ will implement full merging.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export type LoadedAgent = {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  incremental?: boolean;
  default_rules?: string[];
  body: string;
};

export async function loadAgent(
  agentName: string,
  pluginRoot: string,
  projectRoot: string,
): Promise<LoadedAgent> {
  const candidates = [
    join(projectRoot, '.claude', 'agents', `${agentName}.md`),
    join(pluginRoot, 'agents', `${agentName}.md`),
  ];
  for (const path of candidates) {
    try {
      await fs.access(path);
      return parseAgentFile(await fs.readFile(path, 'utf8'));
    } catch {
      // try next
    }
  }
  throw new Error(
    `agent '${agentName}' not found in ${candidates.join(' or ')}`,
  );
}

function parseAgentFile(raw: string): LoadedAgent {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = (YAML.parse(frontmatter) ?? {}) as Record<string, unknown>;
  return {
    name: typeof fm.name === 'string' ? fm.name : '',
    description: typeof fm.description === 'string' ? fm.description : undefined,
    model: typeof fm.model === 'string' ? fm.model : undefined,
    tools: parseStringArray(fm.tools),
    maxTurns: typeof fm.maxTurns === 'number' ? fm.maxTurns : undefined,
    incremental: typeof fm.incremental === 'boolean' ? fm.incremental : undefined,
    default_rules: parseStringArray(fm.default_rules),
    body: body.trim(),
  };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: '', body: raw };
  return { frontmatter: raw.slice(4, end), body: raw.slice(end + 5) };
}

function parseStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === 'string');
  return items.length > 0 ? items : undefined;
}
