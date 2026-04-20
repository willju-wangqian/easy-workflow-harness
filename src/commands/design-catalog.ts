/**
 * Builds an EWH artifact catalog by walking plugin and project artifact
 * directories, reading only frontmatter. Honors resolution order from CLAUDE.md:
 * - agents + workflows: project wins (dedupe by name, project entry replaces plugin)
 * - rules: concatenate (both plugin and project entries included)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type ArtifactType = 'workflow' | 'agent' | 'rule';
export type ArtifactScope = 'plugin' | 'project';

export type CatalogEntry = {
  type: ArtifactType;
  name: string;
  path: string;
  scope: ArtifactScope;
  description: string;
};

type FrontmatterRaw = {
  name?: string;
  description?: string;
  [key: string]: unknown;
};

async function readFrontmatter(filePath: string): Promise<FrontmatterRaw | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const raw = content.slice(3, end).trim();
  try {
    return parseYaml(raw) as FrontmatterRaw;
  } catch {
    return null;
  }
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...(await walkDir(full)));
    } else if (stat.isFile() && name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

async function collectEntries(
  baseDir: string,
  type: ArtifactType,
  scope: ArtifactScope,
  relativeFrom: string,
): Promise<CatalogEntry[]> {
  const files = await walkDir(baseDir);
  const entries: CatalogEntry[] = [];
  for (const file of files) {
    const fm = await readFrontmatter(file);
    if (!fm || !fm.name) continue;
    const relPath = file.slice(relativeFrom.length).replace(/^\//, '');
    entries.push({
      type,
      name: String(fm.name),
      path: relPath,
      scope,
      description: fm.description ? String(fm.description) : '',
    });
  }
  return entries;
}

/**
 * Build the EWH artifact catalog.
 *
 * Resolution rules (from CLAUDE.md):
 * - agents + workflows: project entry wins — if same name exists in both, keep project only.
 * - rules: concatenate — keep both plugin and project entries (they apply together).
 */
export async function buildCatalog(
  projectRoot: string,
  pluginRoot: string,
): Promise<CatalogEntry[]> {
  const [
    pluginWorkflows,
    pluginAgents,
    pluginRules,
    projectWorkflows,
    projectAgents,
    projectRules,
  ] = await Promise.all([
    collectEntries(join(pluginRoot, 'workflows'), 'workflow', 'plugin', pluginRoot + '/'),
    collectEntries(join(pluginRoot, 'agents'), 'agent', 'plugin', pluginRoot + '/'),
    collectEntries(join(pluginRoot, 'rules'), 'rule', 'plugin', pluginRoot + '/'),
    collectEntries(join(projectRoot, '.claude', 'workflows'), 'workflow', 'project', projectRoot + '/.claude/'),
    collectEntries(join(projectRoot, '.claude', 'agents'), 'agent', 'project', projectRoot + '/.claude/'),
    collectEntries(join(projectRoot, '.claude', 'rules'), 'rule', 'project', projectRoot + '/.claude/'),
  ]);

  // Dedupe agents + workflows: project wins by name
  const dedupeWithProjectWin = (
    plugin: CatalogEntry[],
    project: CatalogEntry[],
  ): CatalogEntry[] => {
    const projectNames = new Set(project.map((e) => e.name));
    return [...plugin.filter((e) => !projectNames.has(e.name)), ...project];
  };

  const workflows = dedupeWithProjectWin(pluginWorkflows, projectWorkflows);
  const agents = dedupeWithProjectWin(pluginAgents, projectAgents);
  // Rules concatenate — no deduplication
  const rules = [...pluginRules, ...projectRules];

  return [...workflows, ...agents, ...rules];
}
