/**
 * `ewh list` — emit the command catalog plus any project overrides.
 *
 * Single-turn: no persisted state; emits `ACTION: done` directly. The body
 * is the contents of `${pluginRoot}/skills/doit/list.md` (with an inline
 * fallback if the file is missing), followed by an optional project-override
 * footer enumerating `.claude/{workflows,rules,agents}/*.md` basenames.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import type { Instruction } from '../state/types.js';

const INLINE_FALLBACK = `\
Easy Workflow Harness — Available Commands

Workflows (multi-step, agent-driven):
  /ewh:doit add-feature [desc]      — plan, implement, review, and test a new feature
  /ewh:doit refine-feature [desc]   — scan, suggest, and apply improvements
  /ewh:doit update-knowledge [desc] — update CLAUDE.md and project docs
  /ewh:doit check-fact [desc]       — cross-validate docs against source code

Subcommands (lightweight, interactive):
  /ewh:doit init                    — bootstrap project and show onboarding guide
  /ewh:doit cleanup                 — run user-configured cleanup tasks
  /ewh:doit create [type]           — scaffold a rule, agent, or workflow
  /ewh:doit expand-tools [desc]     — discover and assign agent tools
  /ewh:doit list                    — show this catalog

Flags:
  --auto-approval / --need-approval — toggle startup confirmation per workflow; use with /ewh:doit <workflow>
  --manage-scripts                  — manage cached scripts before a workflow run; use with /ewh:doit <workflow>
  --manage-tasks                    — configure cleanup tasks; use with /ewh:doit cleanup
  --no-override                     — force built-in subcommand when a same-name project workflow exists; use with /ewh:doit <subcommand>
`;

export type ListOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function buildListInstruction(opts: ListOptions): Promise<Instruction> {
  const body = await buildListBody(opts);
  return { kind: 'done', body };
}

export async function buildListBody(opts: ListOptions): Promise<string> {
  const staticContent = await readListCatalog(opts.pluginRoot);
  const footer = await buildOverrideFooter(opts.projectRoot);
  return footer ? `${staticContent.trimEnd()}\n\n${footer}` : staticContent.trimEnd();
}

async function readListCatalog(pluginRoot: string): Promise<string> {
  const path = join(pluginRoot, 'skills', 'doit', 'list.md');
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    process.stderr.write(
      `[ewh] warning: catalog file ${path} missing — using inline fallback.\n`,
    );
    return INLINE_FALLBACK;
  }
}

async function buildOverrideFooter(projectRoot: string): Promise<string | null> {
  const workflows = await listMdBasenames(join(projectRoot, '.claude', 'workflows'), false);
  const rules = await listMdBasenames(join(projectRoot, '.claude', 'rules'), true);
  const agents = await listMdBasenames(join(projectRoot, '.claude', 'agents'), false);
  if (workflows.length === 0 && rules.length === 0 && agents.length === 0) {
    return null;
  }
  const fmt = (names: string[]) => (names.length > 0 ? names.join(', ') : '—');
  return [
    'Project overrides:',
    `  workflows: ${fmt(workflows)}`,
    `  rules:     ${fmt(rules)}`,
    `  agents:    ${fmt(agents)}`,
  ].join('\n');
}

async function listMdBasenames(dir: string, recursive: boolean): Promise<string[]> {
  try {
    await fs.access(dir);
  } catch {
    return [];
  }
  const pattern = recursive ? '**/*.md' : '*.md';
  const matches = await glob(pattern, { cwd: dir, nodir: true });
  const names = matches
    .map((m) => m.split(/[\\/]/).pop() ?? m)
    .filter((m) => m.endsWith('.md'))
    .map((m) => m.slice(0, -3));
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}
