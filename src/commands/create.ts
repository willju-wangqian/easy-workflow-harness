/**
 * `ewh create [rule|agent|workflow]` — scaffold a new rule/agent/workflow.
 *
 * Multi-turn wizard:
 *   1. If type missing from argv → user-prompt to pick one; LLM writes to a
 *      file and reports --result.
 *   2. gather — user-prompt asks the LLM to author a complete markdown draft
 *      (frontmatter + body) and write it to a scratch file, using the
 *      template at ${pluginRoot}/templates/<type>.md as reference.
 *   3. confirm — binary reads draft, extracts `name:` from frontmatter,
 *      shows the target path with a collision warning if applicable.
 *   4. On --decision yes: copy draft → .claude/<type>s/<name>.md.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import type {
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';

export type CreateType = 'rule' | 'agent' | 'workflow';

export type CreateStartOptions = {
  projectRoot: string;
  pluginRoot: string;
  type?: string;
};

export type CreateResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

export async function startCreate(opts: CreateStartOptions): Promise<CreateResult> {
  const type = normalizeType(opts.type);
  if (!type) {
    const scratch = typeChoicePath(opts.projectRoot);
    const state: SubcommandState = { kind: 'create', phase: 'ask-type' };
    return {
      state,
      instruction: {
        kind: 'user-prompt',
        body: [
          'Which type would you like to create: rule, agent, or workflow?',
          '',
          `Ask the user, then write the single chosen word (no quotes, no prose) to:`,
          `  ${scratch}`,
          '',
          'Then: ewh report --run <id> --step 0 --result <that-path>',
        ].join('\n'),
      },
    };
  }
  return gatherStep(opts.projectRoot, opts.pluginRoot, type);
}

async function gatherStep(
  projectRoot: string,
  pluginRoot: string,
  type: CreateType,
): Promise<CreateResult> {
  const draftPath = draftScratchPath(projectRoot, type);
  const templatePath = join(pluginRoot, 'templates', `${type}.md`);
  const state: SubcommandState = { kind: 'create', phase: 'gather', type, input_path: draftPath };
  return {
    state,
    instruction: {
      kind: 'user-prompt',
      body: [
        `Scaffolding a new ${type}.`,
        '',
        `Template reference (required frontmatter + body structure):`,
        `  ${templatePath}`,
        '',
        'Gather the required details from the user (ask follow-up questions as',
        'needed), then author a complete markdown draft — frontmatter plus',
        'body — and write it to:',
        `  ${draftPath}`,
        '',
        'Requirements:',
        '  - All required frontmatter fields present and non-empty.',
        `  - \`name:\` uses kebab-case (this becomes the filename).`,
        ...(type === 'agent'
          ? [
              '  - Body ends with the literal `AGENT_COMPLETE` sentinel instruction.',
              '  - Includes a `## Before You Start` self-gating section.',
            ]
          : []),
        ...(type === 'workflow' ? ['  - Contains a `## Steps` YAML sequence.'] : []),
        '',
        `Then: ewh report --run <id> --step 0 --result ${draftPath}`,
      ].join('\n'),
    },
  };
}

export type CreateContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueCreate(
  run: RunState,
  report: Report,
  opts: CreateContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'create') {
    throw new Error('create report called with non-create subcommand state');
  }
  if (sub.phase === 'ask-type') {
    if (report.kind === 'error') throw new Error(`create ask-type: ${report.message}`);
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('create ask-type: expected --result <path>');
    }
    const raw = (await fs.readFile(report.result_path, 'utf8')).trim();
    const type = normalizeType(raw);
    if (!type) {
      throw new Error(`create: invalid type '${raw}' (expected rule/agent/workflow)`);
    }
    const gather = await gatherStep(opts.projectRoot, opts.pluginRoot, type);
    run.subcommand_state = gather.state;
    return gather.instruction;
  }
  if (sub.phase === 'gather') {
    if (report.kind === 'error') throw new Error(`create gather: ${report.message}`);
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('create gather: expected --result <path>');
    }
    const draft = await fs.readFile(report.result_path, 'utf8');
    const name = extractFrontmatterName(draft);
    if (!name) {
      throw new Error(
        'create: could not extract `name:` from draft frontmatter — rewrite the draft',
      );
    }
    const target = targetPath(opts.projectRoot, sub.type, name);
    const collision = await fileExists(target);
    run.subcommand_state = {
      kind: 'create',
      phase: 'confirm',
      type: sub.type,
      name,
      draft,
      target_path: target,
    };
    const lines: string[] = [
      `Proposed ${sub.type}: ${target}`,
      '',
      '--- draft ---',
      draft.trimEnd(),
      '--- end draft ---',
      '',
    ];
    if (collision) {
      lines.push(
        `⚠ File already exists at ${target}. Writing will overwrite it.`,
        '',
      );
    }
    lines.push(
      `Write this file?`,
      `  confirm: ewh report --run ${run.run_id} --step 0 --decision yes`,
      `  abort:   ewh report --run ${run.run_id} --abort`,
    );
    return {
      kind: 'user-prompt',
      body: lines.join('\n'),
      report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
    };
  }
  if (sub.phase === 'confirm') {
    if (report.kind !== 'decision') {
      throw new Error(`create confirm: expected --decision, got ${report.kind}`);
    }
    if (report.decision === 'no') {
      run.subcommand_state = undefined;
      return { kind: 'done', body: 'Create aborted; no file written.' };
    }
    await writeCreatedFile(sub.target_path, sub.draft);
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: `Created ${sub.target_path}. Effective on next workflow run.`,
    };
  }
  throw new Error(`create: unhandled phase ${(sub as { phase: string }).phase}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

export function normalizeType(raw: string | undefined): CreateType | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'rule' || v === 'agent' || v === 'workflow') return v;
  return null;
}

export function typeChoicePath(projectRoot: string): string {
  return join(projectRoot, '.ewh-artifacts', 'create-type.txt');
}

export function draftScratchPath(projectRoot: string, type: CreateType): string {
  return join(projectRoot, '.ewh-artifacts', `create-${type}-draft.md`);
}

export function targetPath(projectRoot: string, type: CreateType, name: string): string {
  const dir = `${type}s`;
  return join(projectRoot, '.claude', dir, `${name}.md`);
}

export function extractFrontmatterName(body: string): string | null {
  if (!body.startsWith('---\n')) return null;
  const end = body.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const fmText = body.slice(4, end);
  let fm: unknown;
  try {
    fm = YAML.parse(fmText);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;
  const v = (fm as Record<string, unknown>).name;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function writeCreatedFile(target: string, content: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
