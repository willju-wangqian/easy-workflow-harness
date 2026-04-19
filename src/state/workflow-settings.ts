/**
 * Per-workflow persistent settings stored in `.claude/ewh-state.json`.
 *
 * `auto_compliance` is intentionally not a persisted field per spec §Gate Model.
 * Callers must reject `--yolo --save` before calling writeWorkflowSettings.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CleanupTask, AgentToolEntry } from './types.js';

export type WorkflowSettings = {
  auto_structural: boolean;
  max_error_retries: number;
};

const DEFAULTS: WorkflowSettings = {
  auto_structural: false,
  max_error_retries: 2,
};

const STATE_FILE = join('.claude', 'ewh-state.json');

export function ewhStatePath(projectRoot: string): string {
  return join(projectRoot, STATE_FILE);
}

export type ChunkedPatterns = {
  include: string[];
  exclude?: string[];
};

export type EwhStateFile = {
  workflow_settings?: Record<string, Partial<WorkflowSettings>>;
  /** Keyed as `<workflow>/<step>` per spec §1c. */
  chunked_patterns?: Record<string, ChunkedPatterns>;
  cleanup_tasks?: CleanupTask[];
  agent_tools?: Record<string, AgentToolEntry>;
  [key: string]: unknown;
};

export async function readEwhStateFile(projectRoot: string): Promise<EwhStateFile> {
  const path = ewhStatePath(projectRoot);
  try {
    const content = await fs.readFile(path, 'utf8');
    return JSON.parse(content) as EwhStateFile;
  } catch {
    return {};
  }
}

export async function writeEwhStateFile(
  projectRoot: string,
  state: EwhStateFile,
): Promise<void> {
  await atomicWriteStateFile(ewhStatePath(projectRoot), state);
}

export async function readWorkflowSettings(
  projectRoot: string,
  workflowName: string,
): Promise<WorkflowSettings> {
  const path = join(projectRoot, STATE_FILE);
  let raw: EwhStateFile = {};
  try {
    const content = await fs.readFile(path, 'utf8');
    raw = JSON.parse(content) as EwhStateFile;
  } catch {
    // missing file or parse error → use defaults
  }
  return { ...DEFAULTS, ...(raw.workflow_settings?.[workflowName] ?? {}) };
}

export async function writeWorkflowSettings(
  projectRoot: string,
  workflowName: string,
  settings: Partial<WorkflowSettings>,
): Promise<void> {
  const path = join(projectRoot, STATE_FILE);
  let raw: EwhStateFile = {};
  try {
    const content = await fs.readFile(path, 'utf8');
    raw = JSON.parse(content) as EwhStateFile;
  } catch {
    // start fresh
  }
  raw.workflow_settings ??= {};
  raw.workflow_settings[workflowName] = {
    ...(raw.workflow_settings[workflowName] ?? {}),
    ...settings,
  };
  await atomicWriteStateFile(path, raw);
}

export async function readChunkedPatterns(
  projectRoot: string,
  workflowName: string,
  stepName: string,
): Promise<ChunkedPatterns | null> {
  const path = join(projectRoot, STATE_FILE);
  let raw: EwhStateFile = {};
  try {
    const content = await fs.readFile(path, 'utf8');
    raw = JSON.parse(content) as EwhStateFile;
  } catch {
    return null;
  }
  const key = `${workflowName}/${stepName}`;
  return raw.chunked_patterns?.[key] ?? null;
}

export async function writeChunkedPatterns(
  projectRoot: string,
  workflowName: string,
  stepName: string,
  patterns: ChunkedPatterns,
): Promise<void> {
  const path = join(projectRoot, STATE_FILE);
  let raw: EwhStateFile = {};
  try {
    const content = await fs.readFile(path, 'utf8');
    raw = JSON.parse(content) as EwhStateFile;
  } catch {
    // start fresh
  }
  raw.chunked_patterns ??= {};
  raw.chunked_patterns[`${workflowName}/${stepName}`] = patterns;
  await atomicWriteStateFile(path, raw);
}

async function atomicWriteStateFile(path: string, raw: EwhStateFile): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(raw, null, 2), 'utf8');
  await fs.rename(tmp, path);
}
