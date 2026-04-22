/**
 * Context Contract loader (Session 1).
 *
 * Reads `.claude/ewh-workflows/<name>.json` and validates its shape against
 * the `WorkflowContract` type. Does NOT perform referential-integrity checks
 * (rule file exists, artifact produced upstream, etc.) — that is Session 6's
 * doctor responsibility.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  ContextEntry,
  ContractStep,
  WorkflowContract,
} from './contract.js';

export async function loadContract(path: string): Promise<WorkflowContract> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `contract '${path}' could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `contract '${path}' is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return validateContract(data, path);
}

export async function resolveContractPath(
  projectRoot: string,
  name: string,
): Promise<string | null> {
  const path = join(projectRoot, '.claude', 'ewh-workflows', `${name}.json`);
  try {
    await fs.access(path);
    return path;
  } catch {
    return null;
  }
}

function validateContract(data: unknown, path: string): WorkflowContract {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`contract '${path}': top level must be a JSON object`);
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`contract '${path}': 'name' must be a non-empty string`);
  }
  if (typeof obj.description !== 'string') {
    throw new Error(`contract '${path}': 'description' must be a string`);
  }
  if (!Array.isArray(obj.steps)) {
    throw new Error(`contract '${path}': 'steps' must be an array`);
  }
  const steps = obj.steps.map((raw, i) => validateStep(raw, i, path));
  return {
    name: obj.name,
    description: obj.description,
    steps,
  };
}

function validateStep(raw: unknown, i: number, path: string): ContractStep {
  const ctx = `contract '${path}': step #${i + 1}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: must be a JSON object`);
  }
  const s = raw as Record<string, unknown>;
  const name = s.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${ctx}: 'name' must be a non-empty string`);
  }
  const where = `contract '${path}': step '${name}'`;
  if (typeof s.agent !== 'string' || s.agent.length === 0) {
    throw new Error(`${where}: 'agent' must be a non-empty string`);
  }
  if (typeof s.description !== 'string') {
    throw new Error(`${where}: 'description' must be a string`);
  }
  if (s.gate !== 'structural' && s.gate !== 'auto') {
    throw new Error(
      `${where}: 'gate' must be 'structural' or 'auto' (got ${JSON.stringify(s.gate)})`,
    );
  }
  const produces = validateStringArray(s.produces, `${where}: 'produces'`);
  const context = validateContextEntries(s.context, where);
  const requires = validateRequires(s.requires, where);
  if (typeof s.chunked !== 'boolean') {
    throw new Error(`${where}: 'chunked' must be a boolean`);
  }
  if (s.script !== null && typeof s.script !== 'string') {
    throw new Error(`${where}: 'script' must be a string or null`);
  }
  if (s.script_fallback !== 'gate' && s.script_fallback !== 'auto') {
    throw new Error(
      `${where}: 'script_fallback' must be 'gate' or 'auto' (got ${JSON.stringify(s.script_fallback)})`,
    );
  }
  return {
    name,
    agent: s.agent,
    description: s.description,
    gate: s.gate,
    produces,
    context,
    requires,
    chunked: s.chunked,
    script: s.script,
    script_fallback: s.script_fallback,
  };
}

function validateStringArray(v: unknown, ctx: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`${ctx} must be an array`);
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(`${ctx}[${i}] must be a string`);
    }
    return item;
  });
}

function validateContextEntries(v: unknown, where: string): ContextEntry[] {
  if (!Array.isArray(v)) {
    throw new Error(`${where}: 'context' must be an array`);
  }
  return v.map((raw, i) => {
    const ectx = `${where}: context[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${ectx} must be a JSON object`);
    }
    const e = raw as Record<string, unknown>;
    if (e.type !== 'rule' && e.type !== 'artifact' && e.type !== 'file') {
      throw new Error(
        `${ectx}: 'type' must be 'rule', 'artifact', or 'file' (got ${JSON.stringify(e.type)})`,
      );
    }
    if (typeof e.ref !== 'string' || e.ref.length === 0) {
      throw new Error(`${ectx}: 'ref' must be a non-empty string`);
    }
    return { type: e.type, ref: e.ref } as ContextEntry;
  });
}

function validateRequires(
  v: unknown,
  where: string,
): ContractStep['requires'] {
  if (!Array.isArray(v)) {
    throw new Error(`${where}: 'requires' must be an array`);
  }
  return v.map((raw, i) => {
    const rctx = `${where}: requires[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${rctx} must be a JSON object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.file_exists === 'string') {
      return { file_exists: r.file_exists };
    }
    if (typeof r.prior_step === 'string' && typeof r.has === 'string') {
      return { prior_step: r.prior_step, has: r.has };
    }
    throw new Error(
      `${rctx} must be {file_exists: string} or {prior_step: string, has: string}`,
    );
  });
}
