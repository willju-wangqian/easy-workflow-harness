/**
 * `ewh doctor` — environment health check.
 *
 * Single-turn. Runs a fixed battery of checks against the plugin install
 * and the project's `.ewh-artifacts/` / `.claude/` state. Emits a per-check
 * line (`✓` / `!` / `✗`), indented issue details on failure/warning, and
 * a `SUMMARY` line. Exit codes: 0 all pass, 1 warn-only, 2 any fail.
 *
 * `--smoke` (check 11) is a separate step and not implemented here.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { SENTINEL, checkSentinel } from '../state/sentinel.js';
import { loadWorkflow } from '../workflow/parse.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

export type CheckResult = {
  id: number;
  label: string;
  status: CheckStatus;
  /** Parenthetical appended to a passing line (e.g. "v22.10.0"). */
  detail?: string;
  /** Indented lines shown under a non-pass check. */
  issues?: string[];
};

export type DoctorOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export type DoctorOutput = {
  output: string;
  exitCode: 0 | 1 | 2;
  results: CheckResult[];
};

export async function runDoctor(opts: DoctorOptions): Promise<DoctorOutput> {
  const results: CheckResult[] = [];
  results.push(await checkNodeVersion(opts.pluginRoot));
  results.push(await checkBinaryPresent(opts.pluginRoot));
  results.push(await checkPluginDirs(opts.pluginRoot));
  results.push(await checkArtifactsWritable(opts.projectRoot));
  results.push(await checkEwhState(opts.projectRoot));
  results.push(await checkHarnessConfig(opts.projectRoot));
  results.push(await checkHooksJson(opts.pluginRoot));
  results.push(await checkAgents(opts.pluginRoot));
  results.push(await checkRules(opts.pluginRoot));
  results.push(await checkWorkflows(opts.pluginRoot, opts.projectRoot));
  return formatDoctor(results);
}

function formatDoctor(results: CheckResult[]): DoctorOutput {
  const lines: string[] = ['ewh doctor'];
  for (const r of results) {
    const marker = r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✗';
    const paren = renderParen(r);
    lines.push(`  ${marker} ${r.label}${paren}`);
    if (r.status !== 'pass' && r.issues) {
      for (const issue of r.issues) lines.push(`      ${issue}`);
    }
  }
  const fail = results.filter((r) => r.status === 'fail').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const pass = results.filter((r) => r.status === 'pass').length;
  lines.push(`SUMMARY: ${fail} fail, ${warn} warn, ${pass} pass`);
  const exitCode: 0 | 1 | 2 = fail > 0 ? 2 : warn > 0 ? 1 : 0;
  return { output: lines.join('\n') + '\n', exitCode, results };
}

function renderParen(r: CheckResult): string {
  if (r.status === 'pass') return r.detail ? ` (${r.detail})` : '';
  const n = r.issues?.length ?? 0;
  if (r.status === 'warn') return ` (warning: ${n} issue${n === 1 ? '' : 's'})`;
  return ` (${n} issue${n === 1 ? '' : 's'})`;
}

async function checkNodeVersion(pluginRoot: string): Promise<CheckResult> {
  const current = process.version;
  const currentMajor = Number.parseInt(current.slice(1).split('.')[0]!, 10);
  let requiredMajor: number | null = null;
  try {
    const pkg = JSON.parse(
      await fs.readFile(join(pluginRoot, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    const spec = pkg.engines?.node;
    if (typeof spec === 'string') {
      const m = spec.match(/(\d+)/);
      if (m) requiredMajor = Number.parseInt(m[1]!, 10);
    }
  } catch {
    /* package.json absent → treat as unconstrained */
  }
  const label = 'node version';
  if (requiredMajor !== null && currentMajor < requiredMajor) {
    return {
      id: 1,
      label,
      status: 'fail',
      issues: [`found ${current}, need node >= ${requiredMajor}`],
    };
  }
  return { id: 1, label, status: 'pass', detail: current };
}

async function checkBinaryPresent(pluginRoot: string): Promise<CheckResult> {
  const path = join(pluginRoot, 'bin', 'ewh.mjs');
  const label = 'binary present';
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) {
      return { id: 2, label, status: 'fail', issues: [`${path}: not a regular file`] };
    }
  } catch (err) {
    return {
      id: 2,
      label,
      status: 'fail',
      issues: [`${path}: missing (${errMsg(err)})`],
    };
  }
  try {
    await fs.access(path, fs.constants.X_OK);
  } catch {
    return {
      id: 2,
      label,
      status: 'fail',
      issues: [`${path}: not executable (chmod +x)`],
    };
  }
  return { id: 2, label, status: 'pass' };
}

async function checkPluginDirs(pluginRoot: string): Promise<CheckResult> {
  const label = 'plugin root layout';
  const required = ['workflows', 'agents', 'rules'];
  const issues: string[] = [];
  for (const name of required) {
    const path = join(pluginRoot, name);
    try {
      const st = await fs.stat(path);
      if (!st.isDirectory()) issues.push(`${name}/: not a directory`);
    } catch {
      issues.push(`${name}/: missing`);
    }
  }
  if (issues.length > 0) return { id: 3, label, status: 'fail', issues };
  return { id: 3, label, status: 'pass' };
}

async function checkArtifactsWritable(projectRoot: string): Promise<CheckResult> {
  const label = '.ewh-artifacts writable';
  const dir = join(projectRoot, '.ewh-artifacts');
  const probe = join(dir, `.doctor-probe-${randomBytes(4).toString('hex')}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'doctor-probe\n', 'utf8');
    await fs.unlink(probe);
  } catch (err) {
    return { id: 4, label, status: 'fail', issues: [errMsg(err)] };
  }
  return { id: 4, label, status: 'pass' };
}

async function checkEwhState(projectRoot: string): Promise<CheckResult> {
  const label = 'ewh-state.json';
  const path = join(projectRoot, '.claude', 'ewh-state.json');
  let body: string;
  try {
    body = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { id: 5, label, status: 'pass', detail: 'not present' };
    }
    return { id: 5, label, status: 'warn', issues: [errMsg(err)] };
  }
  try {
    JSON.parse(body);
    return { id: 5, label, status: 'pass' };
  } catch (err) {
    return { id: 5, label, status: 'warn', issues: [`parse error: ${errMsg(err)}`] };
  }
}

async function checkHarnessConfig(projectRoot: string): Promise<CheckResult> {
  const label = 'CLAUDE.md Harness Config';
  const path = join(projectRoot, 'CLAUDE.md');
  try {
    const body = await fs.readFile(path, 'utf8');
    if (!/^##\s+Harness Config\b/m.test(body)) {
      return {
        id: 6,
        label,
        status: 'warn',
        issues: ['CLAUDE.md has no `## Harness Config` section'],
      };
    }
    return { id: 6, label, status: 'pass' };
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { id: 6, label, status: 'pass', detail: 'not present' };
    }
    return { id: 6, label, status: 'warn', issues: [errMsg(err)] };
  }
}

async function checkHooksJson(pluginRoot: string): Promise<CheckResult> {
  const label = 'hooks.json';
  const path = join(pluginRoot, 'hooks', 'hooks.json');
  let body: string;
  try {
    body = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { id: 7, label, status: 'warn', issues: ['hooks/hooks.json missing'] };
    }
    return { id: 7, label, status: 'warn', issues: [errMsg(err)] };
  }
  try {
    JSON.parse(body);
    return { id: 7, label, status: 'pass' };
  } catch (err) {
    return { id: 7, label, status: 'warn', issues: [`parse error: ${errMsg(err)}`] };
  }
}

async function checkAgents(pluginRoot: string): Promise<CheckResult> {
  const label = 'plugin agents';
  const dir = join(pluginRoot, 'agents');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir))
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch {
    return { id: 8, label, status: 'fail', issues: ['agents/ directory missing'] };
  }
  const issues: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    const body = await fs.readFile(path, 'utf8');
    const fmErr = validateFrontmatter(body, ['name']);
    if (fmErr) {
      issues.push(`agents/${name}: ${fmErr}`);
      continue;
    }
    if (!checkSentinel(body)) {
      issues.push(`agents/${name}: missing ${SENTINEL} sentinel`);
    }
  }
  if (issues.length > 0) return { id: 8, label, status: 'fail', issues };
  return { id: 8, label, status: 'pass', detail: `${entries.length} ok` };
}

async function checkRules(pluginRoot: string): Promise<CheckResult> {
  const label = 'plugin rules';
  const dir = join(pluginRoot, 'rules');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { recursive: true }))
      .map(String)
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch {
    return { id: 9, label, status: 'fail', issues: ['rules/ directory missing'] };
  }
  const issues: string[] = [];
  for (const rel of entries) {
    const path = join(dir, rel);
    const body = await fs.readFile(path, 'utf8');
    const fmErr = validateFrontmatter(body, ['name']);
    if (fmErr) issues.push(`rules/${rel}: ${fmErr}`);
  }
  if (issues.length > 0) return { id: 9, label, status: 'fail', issues };
  return { id: 9, label, status: 'pass', detail: `${entries.length} ok` };
}

async function checkWorkflows(
  pluginRoot: string,
  projectRoot: string,
): Promise<CheckResult> {
  const label = 'plugin workflows';
  const dir = join(pluginRoot, 'workflows');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir))
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch {
    return { id: 10, label, status: 'fail', issues: ['workflows/ directory missing'] };
  }
  const issues: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const wf = await loadWorkflow(path);
      for (const step of wf.steps) {
        if (step.agent) {
          const found =
            (await fileExists(join(projectRoot, '.claude', 'agents', `${step.agent}.md`))) ||
            (await fileExists(join(pluginRoot, 'agents', `${step.agent}.md`)));
          if (!found) {
            issues.push(
              `workflows/${name}: step '${step.name}' references missing agent '${step.agent}'`,
            );
          }
        }
        for (const ruleName of step.rules ?? []) {
          const pluginMatches = await findRuleFiles(ruleName, join(pluginRoot, 'rules'));
          const projectMatches = await findRuleFiles(
            ruleName,
            join(projectRoot, '.claude', 'rules'),
          );
          if (pluginMatches.length === 0 && projectMatches.length === 0) {
            issues.push(
              `workflows/${name}: step '${step.name}' references missing rule '${ruleName}'`,
            );
          }
        }
      }
    } catch (err) {
      issues.push(`workflows/${name}: ${errMsg(err)}`);
    }
  }
  if (issues.length > 0) return { id: 10, label, status: 'fail', issues };
  return { id: 10, label, status: 'pass', detail: `${entries.length} ok` };
}

function validateFrontmatter(raw: string, required: string[]): string | null {
  if (!raw.startsWith('---\n')) return 'missing YAML frontmatter';
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return 'unterminated YAML frontmatter';
  let parsed: Record<string, unknown>;
  try {
    parsed = (YAML.parse(raw.slice(4, end)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return `invalid YAML frontmatter: ${errMsg(err)}`;
  }
  for (const field of required) {
    const v = parsed[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      return `missing required frontmatter field '${field}'`;
    }
  }
  return null;
}

async function findRuleFiles(name: string, dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
  const target = `${name}.md`;
  return entries.filter((e) => e === target || e.endsWith(`/${target}`));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
