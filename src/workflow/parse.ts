/**
 * Minimal workflow parser for Phase 1.
 *
 * Reads a workflow file (`workflows/<name>.md` or
 * `.claude/workflows/<name>.md`) and produces a `WorkflowDef`. The project
 * override takes precedence over the plugin copy, matching dispatcher §1
 * resolution rules.
 *
 * Phase 1 only needs: frontmatter (name/description/trigger) + a `## Steps`
 * list where each step is a YAML block with at minimum `name:` and
 * `gate:`. Richer step fields (agent, rules, reads, requires, etc.) are
 * declared in types.ts but only minimally populated here.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ContextRef, Step, WorkflowDef } from '../state/types.js';

type RawStep = {
  name?: unknown;
  agent?: unknown;
  gate?: unknown;
  description?: unknown;
  message?: unknown;
  rules?: unknown;
  reads?: unknown;
  artifact?: unknown;
  context?: unknown;
  requires?: unknown;
  chunked?: unknown;
  script?: unknown;
  script_fallback?: unknown;
};

export async function resolveWorkflowPath(
  projectRoot: string,
  pluginRoot: string,
  name: string,
): Promise<string> {
  const candidates = [
    join(projectRoot, '.claude', 'workflows', `${name}.md`),
    join(pluginRoot, 'workflows', `${name}.md`),
  ];
  for (const path of candidates) {
    try {
      await fs.access(path);
      return path;
    } catch {
      // try next
    }
  }
  throw new Error(
    `workflow '${name}' not found in ${candidates.join(' or ')}`,
  );
}

export async function loadWorkflow(path: string): Promise<WorkflowDef> {
  const body = await fs.readFile(path, 'utf8');
  const { frontmatter, rest } = splitFrontmatter(body);
  const fm = (YAML.parse(frontmatter) ?? {}) as Record<string, unknown>;
  const name = requireString(fm.name, 'workflow frontmatter: name');
  const steps = parseSteps(rest);
  return {
    name,
    description: typeof fm.description === 'string' ? fm.description : undefined,
    trigger: typeof fm.trigger === 'string' ? fm.trigger : undefined,
    steps,
  };
}

function splitFrontmatter(body: string): { frontmatter: string; rest: string } {
  if (!body.startsWith('---\n')) {
    throw new Error('workflow file missing YAML frontmatter');
  }
  const end = body.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error('workflow file has unterminated YAML frontmatter');
  }
  return {
    frontmatter: body.slice(4, end),
    rest: body.slice(end + 5),
  };
}

/**
 * Parse the `## Steps` section. The established v1 convention is a YAML
 * sequence written directly under the heading:
 *
 *     ## Steps
 *
 *     - name: plan
 *       gate: structural
 *       rules: [coding]
 *
 *     - name: code
 *       agent: coder
 *       gate: auto
 *
 * We extract everything between `## Steps` and the next `##` (or EOF),
 * parse it as a YAML sequence, and keep only the fields Phase 1 needs.
 * Unknown fields are ignored so future-phase authoring still parses.
 */
function parseSteps(body: string): Step[] {
  const headingMatch = body.match(/^##\s+Steps\b[^\n]*\n/m);
  if (!headingMatch) {
    throw new Error("workflow missing '## Steps' section");
  }
  const start = headingMatch.index! + headingMatch[0].length;
  const nextHeadingRel = body.slice(start).search(/^##\s+\S/m);
  const sectionBody =
    nextHeadingRel === -1 ? body.slice(start) : body.slice(start, start + nextHeadingRel);

  let parsed: unknown;
  try {
    parsed = YAML.parse(sectionBody);
  } catch (err) {
    throw new Error(
      `workflow '## Steps' section is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "workflow '## Steps' section must be a YAML sequence of step mappings",
    );
  }

  const steps: Step[] = parsed.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`step #${i + 1}: must be a YAML mapping`);
    }
    const r = raw as RawStep;
    return {
      name: requireString(r.name, `step #${i + 1}: name`),
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      gate: r.gate === 'structural' ? 'structural' : 'auto',
      description: typeof r.description === 'string' ? r.description : undefined,
      message: typeof r.message === 'string' ? r.message : undefined,
      rules: parseStringArray(r.rules),
      reads: parseStringArray(r.reads),
      artifact: typeof r.artifact === 'string' ? r.artifact : undefined,
      context: parseContextRefs(r.context),
      // Deferred fields — parsed and stored, acted on in Phase 3+ :
      requires: r.requires ?? undefined,
      chunked: typeof r.chunked === 'boolean' ? r.chunked : undefined,
      script: typeof r.script === 'string' ? r.script : undefined,
      script_fallback:
        r.script_fallback === 'auto'
          ? 'auto'
          : r.script_fallback === 'gate'
            ? 'gate'
            : undefined,
      state: { phase: 'pending' },
    };
  });
  if (steps.length === 0) {
    throw new Error("workflow '## Steps' section has no steps");
  }
  return steps;
}

function requireString(v: unknown, ctx: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx} must be a non-empty string`);
  }
  return v;
}

function parseStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === 'string');
  return items.length > 0 ? items : undefined;
}

function parseContextRefs(v: unknown): ContextRef[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const refs: ContextRef[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.step !== 'string') continue;
    const detail =
      r.detail === 'raw' || r.detail === 'full' || r.detail === 'summary'
        ? r.detail
        : 'summary';
    refs.push({ step: r.step, detail });
  }
  return refs.length > 0 ? refs : undefined;
}
