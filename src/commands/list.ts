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
  /ewh:doit design "<desc>"         — design a rule, agent, or workflow conversationally
  /ewh:doit design modify <target>  — modify an existing agent/rule or a workflow step via LLM ferry
  /ewh:doit manage <workflow>       — fill runtime fields (context, produces, gate, …) for a workflow contract
  /ewh:doit migrate                 — one-shot upgrade: convert .claude/workflows/*.md → .claude/ewh-workflows/*.{md,json}
  /ewh:doit expand-tools [desc]     — discover and assign agent tools
  /ewh:doit list                    — show this catalog
  /ewh:doit doctor [--smoke]        — environment health check

Flags:
  --trust                           — auto-approve structural gates this run (use with --save to persist)
  --yolo                            — --trust + auto-skip compliance (never persisted)
  --max-retries N                   — override max_error_retries for this run (use with --save to persist)
  --save                            — persist applied flag values to workflow_settings
  --strict                          — enable strict drift detection for this run
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
  const contracts = await listJsonBasenames(
    join(projectRoot, '.claude', 'ewh-workflows'),
  );
  const rules = await listMdBasenames(join(projectRoot, '.claude', 'rules'), true);
  const agents = await listMdBasenames(join(projectRoot, '.claude', 'agents'), false);
  const legacyYaml = await listMdBasenames(
    join(projectRoot, '.claude', 'workflows'),
    false,
  );
  if (
    contracts.length === 0 &&
    rules.length === 0 &&
    agents.length === 0 &&
    legacyYaml.length === 0
  ) {
    return null;
  }
  const fmt = (names: string[]) => (names.length > 0 ? names.join(', ') : '—');
  const lines = [
    'Project contracts and overrides:',
    `  workflows: ${fmt(contracts)}`,
    `  rules:     ${fmt(rules)}`,
    `  agents:    ${fmt(agents)}`,
  ];
  if (legacyYaml.length > 0) {
    lines.push(
      `  (legacy .claude/workflows/: ${fmt(legacyYaml)} — run /ewh:doit migrate)`,
    );
  }
  return lines.join('\n');
}

async function listJsonBasenames(dir: string): Promise<string[]> {
  try {
    await fs.access(dir);
  } catch {
    return [];
  }
  const matches = await glob('*.json', { cwd: dir, nodir: true });
  const names = matches
    .map((m) => m.split(/[\\/]/).pop() ?? m)
    .filter((m) => m.endsWith('.json'))
    .map((m) => m.slice(0, -5));
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
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
