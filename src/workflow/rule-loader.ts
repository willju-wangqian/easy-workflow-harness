/**
 * Rule loader for Phase 2.
 *
 * Resolution order (per CLAUDE.md §Architecture):
 *   1. <pluginRoot>/rules/**-name-.md   (all matches, recursive)
 *   2. <projectRoot>/.claude/rules/**-name-.md   (all matches, recursive)
 *
 * All matches from each root are collected; plugin-root files come first,
 * project-root files come second, so project rules always concatenate after
 * and can override/extend plugin rules. Within each root, files are sorted
 * by their relative path for deterministic ordering.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export type LoadedRule = {
  name: string;
  description?: string;
  severity?: string;
  scope?: string[];
  inject_into?: string[];
  verify?: string | null;
  body: string;
  path: string;
};

export async function loadRulesForStep(
  ruleNames: string[],
  pluginRoot: string,
  projectRoot: string,
): Promise<LoadedRule[]> {
  const results: LoadedRule[] = [];
  for (const name of ruleNames) {
    const pluginMatches = await findRuleFiles(name, join(pluginRoot, 'rules'));
    const projectMatches = await findRuleFiles(
      name,
      join(projectRoot, '.claude', 'rules'),
    );
    for (const path of [...pluginMatches, ...projectMatches]) {
      results.push(await loadRuleFile(path));
    }
  }
  return results;
}

async function findRuleFiles(name: string, dir: string): Promise<string[]> {
  let entries: string[];
  try {
    const raw = await fs.readdir(dir, { recursive: true });
    entries = raw.map(String);
  } catch {
    return [];
  }
  const target = `${name}.md`;
  return entries
    .filter((e) => e === target || e.endsWith(`/${target}`))
    .sort()
    .map((e) => join(dir, e));
}

async function loadRuleFile(path: string): Promise<LoadedRule> {
  const raw = await fs.readFile(path, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = (YAML.parse(frontmatter) ?? {}) as Record<string, unknown>;
  return {
    name: typeof fm.name === 'string' ? fm.name : '',
    description: typeof fm.description === 'string' ? fm.description : undefined,
    severity: typeof fm.severity === 'string' ? fm.severity : undefined,
    scope: parseStringArray(fm.scope),
    inject_into: parseStringArray(fm.inject_into),
    verify: fm.verify === null ? null : typeof fm.verify === 'string' ? fm.verify : undefined,
    body: body.trim(),
    path,
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
