/**
 * Structural diff + referential-integrity check for `design modify` (Session 5).
 *
 * The outer-session LLM writes an array of self-contained step slices (and
 * optional top-level `_order`) to `.ewh-artifacts/modify-<id>/proposed.json`.
 * This module merges those slices into the current workflow contract using
 * the semantics from spec Q9-C:
 *
 *   - Implicit set-difference on `name` handles update/add.
 *   - `_delete: true` on a slice removes that step.
 *   - `_rename_from: "<old>"` renames — downstream `requires.prior_step` and
 *     `context[]` artifact refs matching the renamed step's old `produces`
 *     paths are rewritten to preserve referential integrity.
 *   - Optional `_order` (top-level) enforces the post-merge step order.
 *
 * `diffContract` is pure (no I/O). `checkIntegrity` resolves refs against the
 * filesystem (rule files, agent files, artifact producers).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  ContextEntry,
  ContractStep,
  WorkflowContract,
} from './contract.js';

export type ProposedSlice = {
  name: string;
  _delete?: true;
  _rename_from?: string;
  agent?: string;
  description?: string;
  gate?: ContractStep['gate'];
  produces?: string[];
  context?: ContextEntry[];
  requires?: ContractStep['requires'];
  chunked?: boolean;
  script?: string | null;
  script_fallback?: ContractStep['script_fallback'];
};

export type ProposedInput = {
  steps: ProposedSlice[];
  _order?: string[];
};

export type DiffResult = {
  updated: string[];
  added: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  reordered: boolean;
  /** Structural errors (rename source missing, bad `_order`, duplicate slice names). */
  errors: string[];
  /** Resulting contract after merge. Always returned; callers may still reject
   *  if `errors` is non-empty. */
  merged: WorkflowContract;
};

/**
 * Parse a raw JSON value into a `ProposedInput`. Accepts either:
 *   - An array of slices: `[ {...}, {...} ]`.
 *   - An object: `{ steps: [...], _order?: [...] }`.
 *
 * Throws on shape violations. Does not validate that the embedded slices
 * form a coherent contract — that's `diffContract`'s job.
 */
export function parseProposedInput(raw: unknown): ProposedInput {
  let steps: unknown[];
  let order: unknown;
  if (Array.isArray(raw)) {
    steps = raw;
    order = undefined;
  } else if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) {
      throw new Error(`proposed.json: 'steps' must be an array`);
    }
    steps = obj.steps;
    order = obj._order;
  } else {
    throw new Error(
      `proposed.json: top level must be an array of slices or an object with a 'steps' array`,
    );
  }
  const slices = steps.map((raw, i) => validateSlice(raw, i));
  let parsedOrder: string[] | undefined;
  if (order !== undefined) {
    if (!Array.isArray(order) || order.some((v) => typeof v !== 'string')) {
      throw new Error(`proposed.json: '_order' must be an array of strings`);
    }
    parsedOrder = order as string[];
  }
  return { steps: slices, _order: parsedOrder };
}

function validateSlice(raw: unknown, i: number): ProposedSlice {
  const ctx = `proposed.json: slice #${i + 1}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: must be a JSON object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || s.name.length === 0) {
    throw new Error(`${ctx}: 'name' must be a non-empty string`);
  }
  const where = `proposed.json: slice '${s.name}'`;
  const slice: ProposedSlice = { name: s.name };
  if (s._delete !== undefined) {
    if (s._delete !== true) {
      throw new Error(`${where}: '_delete' must be literal true if present`);
    }
    slice._delete = true;
    return slice;
  }
  if (s._rename_from !== undefined) {
    if (typeof s._rename_from !== 'string' || s._rename_from.length === 0) {
      throw new Error(`${where}: '_rename_from' must be a non-empty string`);
    }
    slice._rename_from = s._rename_from;
  }
  // Remaining fields are optional — merger copies missing fields from the
  // current step (for updates/renames) or applies defaults (for adds).
  if (s.agent !== undefined) {
    if (typeof s.agent !== 'string' || s.agent.length === 0) {
      throw new Error(`${where}: 'agent' must be a non-empty string`);
    }
    slice.agent = s.agent;
  }
  if (s.description !== undefined) {
    if (typeof s.description !== 'string') {
      throw new Error(`${where}: 'description' must be a string`);
    }
    slice.description = s.description;
  }
  if (s.gate !== undefined) {
    if (s.gate !== 'structural' && s.gate !== 'auto') {
      throw new Error(`${where}: 'gate' must be 'structural' or 'auto'`);
    }
    slice.gate = s.gate;
  }
  if (s.produces !== undefined) {
    if (!Array.isArray(s.produces) || s.produces.some((v) => typeof v !== 'string')) {
      throw new Error(`${where}: 'produces' must be an array of strings`);
    }
    slice.produces = s.produces as string[];
  }
  if (s.context !== undefined) {
    slice.context = validateContextArray(s.context, where);
  }
  if (s.requires !== undefined) {
    slice.requires = validateRequiresArray(s.requires, where);
  }
  if (s.chunked !== undefined) {
    if (typeof s.chunked !== 'boolean') {
      throw new Error(`${where}: 'chunked' must be a boolean`);
    }
    slice.chunked = s.chunked;
  }
  if (s.script !== undefined) {
    if (s.script !== null && typeof s.script !== 'string') {
      throw new Error(`${where}: 'script' must be a string or null`);
    }
    slice.script = s.script;
  }
  if (s.script_fallback !== undefined) {
    if (s.script_fallback !== 'gate' && s.script_fallback !== 'auto') {
      throw new Error(`${where}: 'script_fallback' must be 'gate' or 'auto'`);
    }
    slice.script_fallback = s.script_fallback;
  }
  return slice;
}

function validateContextArray(v: unknown, where: string): ContextEntry[] {
  if (!Array.isArray(v)) {
    throw new Error(`${where}: 'context' must be an array`);
  }
  return v.map((raw, i) => {
    const c = `${where}: context[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${c}: must be a JSON object`);
    }
    const e = raw as Record<string, unknown>;
    if (e.type !== 'rule' && e.type !== 'artifact' && e.type !== 'file') {
      throw new Error(`${c}: 'type' must be 'rule', 'artifact', or 'file'`);
    }
    if (typeof e.ref !== 'string' || e.ref.length === 0) {
      throw new Error(`${c}: 'ref' must be a non-empty string`);
    }
    return { type: e.type, ref: e.ref } as ContextEntry;
  });
}

function validateRequiresArray(
  v: unknown,
  where: string,
): ContractStep['requires'] {
  if (!Array.isArray(v)) {
    throw new Error(`${where}: 'requires' must be an array`);
  }
  return v.map((raw, i) => {
    const c = `${where}: requires[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${c}: must be a JSON object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.file_exists === 'string') return { file_exists: r.file_exists };
    if (typeof r.prior_step === 'string' && typeof r.has === 'string') {
      return { prior_step: r.prior_step, has: r.has };
    }
    throw new Error(
      `${c}: must be {file_exists: string} or {prior_step: string, has: string}`,
    );
  });
}

/**
 * Merge proposed slices into the current contract. Pure / synchronous.
 *
 * Rename semantics: when a slice declares `_rename_from: "<old>"`, every
 * downstream step gets its `requires[].prior_step` rewritten, and any
 * `context[]` entry of type 'artifact' whose `ref` matches one of the old
 * step's `produces` paths is rewritten to the new step's `produces` path at
 * the same index (pairwise by array index — common case is one produces).
 */
export function diffContract(
  current: WorkflowContract,
  proposed: ProposedInput,
): DiffResult {
  const errors: string[] = [];
  const updated: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  // Detect duplicate slice names.
  const seen = new Set<string>();
  for (const s of proposed.steps) {
    if (seen.has(s.name)) {
      errors.push(`duplicate slice name '${s.name}' in proposed.json`);
    }
    seen.add(s.name);
  }

  // Build working copy of current steps, indexed by name.
  const byName = new Map<string, ContractStep>(
    current.steps.map((s) => [s.name, cloneStep(s)]),
  );
  const startingOrder = current.steps.map((s) => s.name);

  // Path rewrites collected from renames: old-produces-path → new-produces-path.
  const pathRewrites = new Map<string, string>();
  // Name rewrites collected from renames: old-step-name → new-step-name.
  const nameRewrites = new Map<string, string>();

  // Apply slices in order: delete first (simplifies rename/add collision), then
  // rename, then update/add. Collect rewrites as we go.
  const deletes = proposed.steps.filter((s) => s._delete === true);
  const renames = proposed.steps.filter((s) => s._rename_from !== undefined);
  const rest = proposed.steps.filter(
    (s) => s._delete !== true && s._rename_from === undefined,
  );

  // Deletes.
  for (const s of deletes) {
    if (!byName.has(s.name)) {
      errors.push(`_delete: step '${s.name}' not found in current contract`);
      continue;
    }
    byName.delete(s.name);
    deleted.push(s.name);
  }

  // Renames.
  for (const s of renames) {
    const from = s._rename_from!;
    const to = s.name;
    const src = byName.get(from);
    if (!src) {
      errors.push(
        `_rename_from: source step '${from}' not found (rename → '${to}')`,
      );
      continue;
    }
    if (byName.has(to) && from !== to) {
      errors.push(
        `_rename_from: target name '${to}' collides with an existing step`,
      );
      continue;
    }
    const merged = applyFields(src, s);
    merged.name = to;
    // Collect pairwise produces-path rewrites (src's produces → merged's produces).
    const oldProduces = src.produces;
    const newProduces = merged.produces;
    for (let i = 0; i < oldProduces.length; i++) {
      const oldP = oldProduces[i]!;
      const newP = newProduces[i];
      if (newP !== undefined && newP !== oldP) {
        pathRewrites.set(oldP, newP);
      }
    }
    nameRewrites.set(from, to);
    byName.delete(from);
    byName.set(to, merged);
    renamed.push({ from, to });
  }

  // Updates + adds.
  for (const s of rest) {
    const existing = byName.get(s.name);
    if (existing) {
      const merged = applyFields(existing, s);
      // Collect produces-path rewrites for in-place update too (fixed-name,
      // path-change case — downstream artifact refs should follow).
      for (let i = 0; i < existing.produces.length; i++) {
        const oldP = existing.produces[i]!;
        const newP = merged.produces[i];
        if (newP !== undefined && newP !== oldP) {
          pathRewrites.set(oldP, newP);
        }
      }
      byName.set(s.name, merged);
      updated.push(s.name);
    } else {
      byName.set(s.name, sliceToStep(s));
      added.push(s.name);
    }
  }

  // Determine final order.
  let finalOrder: string[];
  let reordered = false;
  if (proposed._order !== undefined) {
    const requested = proposed._order;
    const requestedSet = new Set(requested);
    const mergedSet = new Set(byName.keys());
    if (
      requested.length !== mergedSet.size ||
      [...mergedSet].some((n) => !requestedSet.has(n)) ||
      requested.some((n) => !mergedSet.has(n))
    ) {
      errors.push(
        `_order mismatch: expected a permutation of {${[...mergedSet].join(', ')}} but got {${requested.join(', ')}}`,
      );
      finalOrder = inferOrder(startingOrder, byName, nameRewrites);
    } else {
      finalOrder = requested;
      const inferred = inferOrder(startingOrder, byName, nameRewrites);
      reordered = !arrayEqual(inferred, requested);
    }
  } else {
    finalOrder = inferOrder(startingOrder, byName, nameRewrites);
  }

  // Apply cross-step rewrites (requires.prior_step + artifact refs).
  const finalSteps: ContractStep[] = [];
  for (const name of finalOrder) {
    const step = byName.get(name)!;
    finalSteps.push(applyRewrites(step, nameRewrites, pathRewrites));
  }

  return {
    updated,
    added,
    deleted,
    renamed,
    reordered,
    errors,
    merged: {
      name: current.name,
      description: current.description,
      steps: finalSteps,
    },
  };
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function inferOrder(
  startingOrder: string[],
  byName: Map<string, ContractStep>,
  nameRewrites: Map<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Preserve original order, substituting renamed names.
  for (const n of startingOrder) {
    const mapped = nameRewrites.get(n) ?? n;
    if (byName.has(mapped) && !seen.has(mapped)) {
      out.push(mapped);
      seen.add(mapped);
    }
  }
  // Append any added steps (not in original order) in slice order — which
  // `byName`'s insertion order reflects since we set them during the `rest` loop.
  for (const n of byName.keys()) {
    if (!seen.has(n)) {
      out.push(n);
      seen.add(n);
    }
  }
  return out;
}

function cloneStep(s: ContractStep): ContractStep {
  return {
    name: s.name,
    agent: s.agent,
    description: s.description,
    gate: s.gate,
    produces: [...s.produces],
    context: s.context.map((c) => ({ ...c })),
    requires: s.requires.map((r) => ({ ...r }) as ContractStep['requires'][number]),
    chunked: s.chunked,
    script: s.script,
    script_fallback: s.script_fallback,
  };
}

function applyFields(base: ContractStep, slice: ProposedSlice): ContractStep {
  return {
    name: base.name, // caller sets `name` explicitly for renames
    agent: slice.agent ?? base.agent,
    description: slice.description ?? base.description,
    gate: slice.gate ?? base.gate,
    produces: slice.produces ? [...slice.produces] : [...base.produces],
    context: slice.context
      ? slice.context.map((c) => ({ ...c }))
      : base.context.map((c) => ({ ...c })),
    requires: slice.requires
      ? slice.requires.map((r) => ({ ...r }) as ContractStep['requires'][number])
      : base.requires.map((r) => ({ ...r }) as ContractStep['requires'][number]),
    chunked: slice.chunked ?? base.chunked,
    script: slice.script === undefined ? base.script : slice.script,
    script_fallback: slice.script_fallback ?? base.script_fallback,
  };
}

function sliceToStep(slice: ProposedSlice): ContractStep {
  // Added steps must carry a full shape. Missing fields get safe defaults so
  // the contract loader still validates; integrity check will flag anything
  // that's actually broken (e.g., unresolved agent).
  return {
    name: slice.name,
    agent: slice.agent ?? '',
    description: slice.description ?? '',
    gate: slice.gate ?? 'structural',
    produces: slice.produces ? [...slice.produces] : [],
    context: slice.context ? slice.context.map((c) => ({ ...c })) : [],
    requires: slice.requires
      ? slice.requires.map((r) => ({ ...r }) as ContractStep['requires'][number])
      : [],
    chunked: slice.chunked ?? false,
    script: slice.script === undefined ? null : slice.script,
    script_fallback: slice.script_fallback ?? 'gate',
  };
}

function applyRewrites(
  step: ContractStep,
  nameRewrites: Map<string, string>,
  pathRewrites: Map<string, string>,
): ContractStep {
  const context = step.context.map((c) => {
    if (c.type === 'artifact' && pathRewrites.has(c.ref)) {
      return { type: 'artifact' as const, ref: pathRewrites.get(c.ref)! };
    }
    return { ...c };
  });
  const requires = step.requires.map((r) => {
    if ('prior_step' in r && nameRewrites.has(r.prior_step)) {
      return { prior_step: nameRewrites.get(r.prior_step)!, has: r.has };
    }
    return { ...r } as ContractStep['requires'][number];
  });
  return { ...step, context, requires };
}

// ── Referential integrity ────────────────────────────────────────────────

export type IntegrityOptions = {
  projectRoot: string;
  pluginRoot: string;
};

/**
 * Walk the merged contract; for every slice that introduced a new ref, verify
 * it resolves. Returns a list of human-readable issue lines (empty = clean).
 */
export async function checkIntegrity(
  merged: WorkflowContract,
  opts: IntegrityOptions,
): Promise<string[]> {
  const issues: string[] = [];

  // Collect earlier-step produces for artifact resolution.
  const producedSoFar = new Set<string>();
  for (const step of merged.steps) {
    // Agent existence.
    if (step.agent.length === 0) {
      issues.push(`step '${step.name}': missing agent`);
    } else if (!(await agentExists(step.agent, opts))) {
      issues.push(
        `step '${step.name}': agent '${step.agent}' not found in .claude/agents/ or agents/`,
      );
    }
    // Context refs.
    for (const c of step.context) {
      if (c.type === 'rule') {
        if (!(await ruleExists(c.ref, opts))) {
          issues.push(
            `step '${step.name}': rule '${c.ref}' not found in rules/ or .claude/rules/`,
          );
        }
      } else if (c.type === 'artifact') {
        if (!producedSoFar.has(c.ref)) {
          issues.push(
            `step '${step.name}': artifact '${c.ref}' not produced by any earlier step`,
          );
        }
      }
      // `type: 'file'` is an escape hatch — no integrity check per spec §2.
    }
    for (const p of step.produces) producedSoFar.add(p);
  }
  return issues;
}

async function agentExists(
  name: string,
  opts: IntegrityOptions,
): Promise<boolean> {
  const candidates = [
    join(opts.projectRoot, '.claude', 'agents', `${name}.md`),
    join(opts.pluginRoot, 'agents', `${name}.md`),
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return true;
  }
  return false;
}

async function ruleExists(
  name: string,
  opts: IntegrityOptions,
): Promise<boolean> {
  const roots = [
    join(opts.projectRoot, '.claude', 'rules'),
    join(opts.pluginRoot, 'rules'),
  ];
  for (const root of roots) {
    if (await findRuleIn(root, `${name}.md`)) return true;
  }
  return false;
}

async function findRuleIn(dir: string, target: string): Promise<boolean> {
  let entries: string[];
  try {
    const raw = await fs.readdir(dir, { recursive: true });
    entries = raw.map(String);
  } catch {
    return false;
  }
  return entries.some((e) => e === target || e.endsWith(`/${target}`));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Summary rendering ────────────────────────────────────────────────────

export function renderDiffSummary(diff: DiffResult, integrity: string[]): string {
  const lines: string[] = [];
  lines.push('Proposed changes:');
  if (diff.added.length) lines.push(`  + added:   ${diff.added.join(', ')}`);
  if (diff.updated.length) lines.push(`  ~ updated: ${diff.updated.join(', ')}`);
  if (diff.renamed.length) {
    lines.push(
      `  → renamed: ${diff.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`,
    );
  }
  if (diff.deleted.length) lines.push(`  − deleted: ${diff.deleted.join(', ')}`);
  if (diff.reordered) lines.push(`  ↕ reordered`);
  if (
    !diff.added.length &&
    !diff.updated.length &&
    !diff.renamed.length &&
    !diff.deleted.length &&
    !diff.reordered
  ) {
    lines.push('  (no structural changes)');
  }
  if (diff.errors.length) {
    lines.push('');
    lines.push('Structural errors:');
    for (const e of diff.errors) lines.push(`  ✗ ${e}`);
  }
  if (integrity.length) {
    lines.push('');
    lines.push('Referential-integrity issues:');
    for (const i of integrity) lines.push(`  ✗ ${i}`);
  }
  return lines.join('\n');
}
