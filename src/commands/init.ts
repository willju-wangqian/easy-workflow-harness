/**
 * `ewh init` — bootstrap a project with Harness Config + gitignore entries.
 *
 * Multi-turn:
 *   1. bash — ask the LLM to scan the project and emit a JSON detection file.
 *   2. user-prompt — show the resulting proposed `## Harness Config` section,
 *      ask to confirm via --decision yes/no.
 *   3. on yes — write/update CLAUDE.md and .gitignore, emit the onboarding
 *      summary as `done`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';

export type InitStartOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export type InitResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

export async function startInit(opts: InitStartOptions): Promise<InitResult> {
  const scanPath = initScanPath(opts.projectRoot);
  const state: SubcommandState = { kind: 'init', phase: 'scan' };
  return {
    state,
    instruction: {
      kind: 'bash',
      body: [
        'Scan this project and emit a JSON file at:',
        `  ${scanPath}`,
        '',
        'Populate as many of these keys as you can detect. Omit a key if you',
        'cannot determine it; do NOT guess:',
        '  language         (e.g. "Python", "TypeScript", "Go")',
        '  test_command     (e.g. "pytest", "npm test")',
        '  check_command    (e.g. "ruff check .", "eslint .")',
        '  source_pattern   (e.g. "src/**/*.py")',
        '  test_pattern     (e.g. "tests/test_*.py")',
        '  doc_build        (e.g. "mkdocs build")',
        '  conventions      (free-form: "PEP 8, type hints")',
        '',
        'Sources to inspect (skip any that do not exist):',
        '  package.json, Makefile, pyproject.toml, go.mod, Cargo.toml',
        '  .eslintrc*, ruff.toml, .prettierrc*, mkdocs.yml',
        '  existing source tree layout (src/, tests/, etc.)',
        '',
        'Create the parent directory if needed. Write only the JSON — no',
        'prose, no markdown fences.',
        '',
        `Then: ewh report --run <id> --step 0 --result ${scanPath}`,
      ].join('\n'),
    },
  };
}

export type InitContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueInit(
  run: RunState,
  report: Report,
  opts: InitContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'init') {
    throw new Error('init report called with non-init subcommand state');
  }
  if (sub.phase === 'scan') {
    if (report.kind === 'error') {
      throw new Error(`init scan failed: ${report.message}`);
    }
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('init scan: expected --result <path>');
    }
    const scanned = await readScanFile(report.result_path);
    const proposedConfig = buildHarnessConfigSection(scanned);
    run.subcommand_state = { kind: 'init', phase: 'propose', scan_result_path: report.result_path };
    return {
      kind: 'user-prompt',
      body: [
        'Proposed Harness Config:',
        '',
        proposedConfig,
        '',
        'Write this to project CLAUDE.md (replacing any existing ## Harness',
        'Config section) and add `.ewh-artifacts/` + `.claude/ewh-state.json`',
        'to .gitignore?',
        `  confirm: ewh report --run ${run.run_id} --step 0 --decision yes`,
        `  abort:   ewh report --run ${run.run_id} --abort`,
      ].join('\n'),
      report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
    };
  }
  if (sub.phase === 'propose') {
    if (report.kind !== 'decision') {
      throw new Error(`init propose: expected --decision, got ${report.kind}`);
    }
    if (report.decision === 'no') {
      run.subcommand_state = undefined;
      return { kind: 'done', body: 'Init aborted; project unchanged.' };
    }
    const scanned = await readScanFile(sub.scan_result_path);
    const section = buildHarnessConfigSection(scanned);
    await upsertHarnessConfig(opts.projectRoot, section);
    await ensureGitignoreEntries(opts.projectRoot);
    run.subcommand_state = undefined;
    return { kind: 'done', body: buildOnboardingSummary() };
  }
  throw new Error(`init: unhandled phase ${(sub as { phase: string }).phase}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

export function initScanPath(projectRoot: string): string {
  return join(projectRoot, '.ewh-artifacts', 'init-scan.json');
}

export type ScanResult = {
  language?: string;
  test_command?: string;
  check_command?: string;
  source_pattern?: string;
  test_pattern?: string;
  doc_build?: string;
  conventions?: string;
};

export async function readScanFile(path: string): Promise<ScanResult> {
  const content = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`init scan file ${path} is not a JSON object`);
  }
  const r = parsed as Record<string, unknown>;
  const pick = (k: string): string | undefined =>
    typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : undefined;
  return {
    language: pick('language'),
    test_command: pick('test_command'),
    check_command: pick('check_command'),
    source_pattern: pick('source_pattern'),
    test_pattern: pick('test_pattern'),
    doc_build: pick('doc_build'),
    conventions: pick('conventions'),
  };
}

export function buildHarnessConfigSection(scan: ScanResult): string {
  const v = (x?: string) => x ?? 'none';
  return [
    '## Harness Config',
    '',
    `- Language: ${v(scan.language)}`,
    `- Test command: ${v(scan.test_command)}`,
    `- Check command: ${v(scan.check_command)}`,
    `- Source pattern: ${v(scan.source_pattern)}`,
    `- Test pattern: ${v(scan.test_pattern)}`,
    `- Doc build: ${v(scan.doc_build)}`,
    `- Conventions: ${v(scan.conventions)}`,
  ].join('\n');
}

export async function upsertHarnessConfig(
  projectRoot: string,
  section: string,
): Promise<void> {
  const path = join(projectRoot, 'CLAUDE.md');
  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch {
    existing = '';
  }
  const updated = replaceOrAppendSection(existing, section);
  await fs.writeFile(path, updated, 'utf8');
}

/**
 * Replace the `## Harness Config` section if present; otherwise append it
 * (prefixed by a blank line when the file has content).
 */
export function replaceOrAppendSection(existing: string, section: string): string {
  const headingRx = /^##\s+Harness Config\s*$/m;
  const m = headingRx.exec(existing);
  if (!m) {
    if (existing.length === 0) return `${section}\n`;
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    return existing + sep + section + '\n';
  }
  const start = m.index;
  const afterHeading = start + m[0].length;
  const rest = existing.slice(afterHeading);
  const nextHeadingRel = rest.search(/^##\s+\S/m);
  const endRel = nextHeadingRel === -1 ? rest.length : nextHeadingRel;
  const tail = rest.slice(endRel);
  const needsNewlineBefore = start > 0 && !existing.slice(0, start).endsWith('\n');
  const prefix = needsNewlineBefore ? '\n' : '';
  const replacedTail = tail.length > 0 ? `\n\n${tail.replace(/^\n+/, '')}` : '\n';
  return existing.slice(0, start) + prefix + section + replacedTail;
}

export async function ensureGitignoreEntries(projectRoot: string): Promise<void> {
  const path = join(projectRoot, '.gitignore');
  const required = ['.ewh-artifacts/', '.claude/ewh-state.json'];
  let current = '';
  try {
    current = await fs.readFile(path, 'utf8');
  } catch {
    current = '';
  }
  const lines = current.split('\n');
  const existing = new Set(lines.map((l) => l.trim()));
  const toAdd = required.filter((r) => !existing.has(r));
  if (toAdd.length === 0) return;
  const needsLeadingNewline = current.length > 0 && !current.endsWith('\n');
  const addition = (needsLeadingNewline ? '\n' : '') + toAdd.join('\n') + '\n';
  await fs.writeFile(path, current + addition, 'utf8');
}

function buildOnboardingSummary(): string {
  return [
    'Easy Workflow Harness is ready.',
    '',
    'Workflows (multi-step, agent-driven):',
    '  /ewh:doit add-feature [desc]      — plan, implement, review, and test a new feature',
    '  /ewh:doit refine-feature [desc]   — scan, suggest, and apply improvements',
    '  /ewh:doit update-knowledge [desc] — update CLAUDE.md and project docs',
    '  /ewh:doit check-fact [desc]       — cross-validate docs against source code',
    '',
    'Subcommands (lightweight, interactive):',
    '  /ewh:doit cleanup                 — run project cleanup tasks',
    '  /ewh:doit design "<desc>"         — design a rule, agent, or workflow conversationally',
    '  /ewh:doit expand-tools [desc]     — discover and assign agent tools',
    '  /ewh:doit init                    — (you just ran this)',
    '',
    'Next steps:',
    '  - Run /ewh:doit cleanup --manage-tasks to configure your cleanup tasks',
    '  - Run /ewh:doit add-feature "your feature" to build something',
    '  - Run /ewh:doit expand-tools "your tools" to extend agent capabilities',
  ].join('\n');
}
