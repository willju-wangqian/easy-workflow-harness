/**
 * `ewh doctor` — environment health check.
 *
 * Single-turn. Runs a fixed battery of checks against the plugin install
 * and the project's `.ewh-artifacts/` / `.claude/` state. Emits a per-check
 * line (`✓` / `!` / `✗`), indented issue details on failure/warning, and
 * a `SUMMARY` line. Exit codes: 0 all pass, 1 warn-only, 2 any fail.
 *
 * `--smoke` adds an 11th check: spawn `node bin/ewh.mjs start list` in a
 * throwaway project dir and assert the dispatcher emits `ACTION: done`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { SENTINEL, checkSentinel } from '../state/sentinel.js';
import { loadWorkflow } from '../workflow/parse.js';
import { loadContract } from '../workflow/contract-loader.js';
import { loadAgent } from '../workflow/agent-loader.js';
import type { WorkflowContract } from '../workflow/contract.js';

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
  /** Run check #11: end-to-end `ewh start list` dry-run. */
  smoke?: boolean;
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
  results.push(await checkProjectContracts(opts.projectRoot, opts.pluginRoot));
  if (opts.smoke) {
    results.push(await checkSmoke(opts.pluginRoot));
    results.push(await checkDesignSmoke(opts.pluginRoot));
  }
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

async function checkProjectContracts(
  projectRoot: string,
  pluginRoot: string,
): Promise<CheckResult> {
  const id = 11;
  const label = 'project contracts';
  const dir = join(projectRoot, '.claude', 'ewh-workflows');
  let names: string[];
  try {
    names = (await fs.readdir(dir))
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { id, label, status: 'pass', detail: 'none' };
    }
    return { id, label, status: 'warn', issues: [errMsg(err)] };
  }
  if (names.length === 0) {
    return { id, label, status: 'pass', detail: 'none' };
  }

  const fails: string[] = [];
  const warns: string[] = [];

  for (const fname of names) {
    const jsonPath = join(dir, fname);
    const where = `ewh-workflows/${fname}`;
    let contract: WorkflowContract;
    try {
      contract = await loadContract(jsonPath);
    } catch (err) {
      fails.push(`${where}: ${errMsg(err)}`);
      continue;
    }

    const priorProduces: string[] = [];
    for (const step of contract.steps) {
      // agent existence
      const agentFound =
        (await fileExists(
          join(projectRoot, '.claude', 'agents', `${step.agent}.md`),
        )) ||
        (await fileExists(join(pluginRoot, 'agents', `${step.agent}.md`)));
      if (!agentFound) {
        fails.push(
          `${where}: step '${step.name}' references missing agent '${step.agent}'`,
        );
      }

      // context refs
      for (let i = 0; i < step.context.length; i++) {
        const entry = step.context[i]!;
        if (entry.type === 'rule') {
          const pluginMatches = await findRuleFiles(
            entry.ref,
            join(pluginRoot, 'rules'),
          );
          const projectMatches = await findRuleFiles(
            entry.ref,
            join(projectRoot, '.claude', 'rules'),
          );
          if (pluginMatches.length === 0 && projectMatches.length === 0) {
            fails.push(
              `${where}: step '${step.name}' context[${i}] rule '${entry.ref}' not found in rules/ or .claude/rules/`,
            );
          }
        } else if (entry.type === 'artifact') {
          if (!priorProduces.includes(entry.ref)) {
            fails.push(
              `${where}: step '${step.name}' context[${i}] artifact '${entry.ref}' not produced by any earlier step`,
            );
          }
        } else {
          const filePath = join(projectRoot, entry.ref);
          if (!(await fileExists(filePath))) {
            fails.push(
              `${where}: step '${step.name}' context[${i}] file '${entry.ref}' does not exist`,
            );
          }
        }
      }

      // drift vs agent default_rules (warn)
      if (agentFound) {
        try {
          const agent = await loadAgent(step.agent, pluginRoot, projectRoot);
          const defaults = new Set(agent.default_rules ?? []);
          const stepRules = new Set(
            step.context
              .filter((e) => e.type === 'rule')
              .map((e) => e.ref),
          );
          const missing = [...defaults].filter((r) => !stepRules.has(r));
          const extra = [...stepRules].filter((r) => !defaults.has(r));
          if (missing.length > 0 || extra.length > 0) {
            const parts: string[] = [];
            if (missing.length > 0) {
              parts.push(`agent default_rules missing from step: [${missing.join(', ')}]`);
            }
            if (extra.length > 0) {
              parts.push(`step rules not in agent default_rules: [${extra.join(', ')}]`);
            }
            warns.push(
              `${where}: step '${step.name}' agent '${step.agent}' default_rules drift: ${parts.join('; ')}`,
            );
          }
        } catch {
          // loadAgent failure is reported above via agentFound
        }
      }

      priorProduces.push(...step.produces);
    }

    // workflow.md ↔ JSON drift (warn)
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    if (!(await fileExists(mdPath))) {
      warns.push(`${where}: no companion .md summary`);
    } else {
      try {
        const md = await loadWorkflow(mdPath);
        const count = Math.max(md.steps.length, contract.steps.length);
        for (let i = 0; i < count; i++) {
          const jStep = contract.steps[i];
          const mStep = md.steps[i];
          if (!jStep || !mStep) {
            warns.push(
              `${where}: step count drift (json=${contract.steps.length} md=${md.steps.length})`,
            );
            break;
          }
          if (jStep.name !== mStep.name) {
            warns.push(
              `${where}: step #${i + 1} name drift (json='${jStep.name}' md='${mStep.name}')`,
            );
          }
          if (mStep.agent && jStep.agent !== mStep.agent) {
            warns.push(
              `${where}: step '${jStep.name}' agent drift (json='${jStep.agent}' md='${mStep.agent}')`,
            );
          }
        }
      } catch (err) {
        warns.push(`${where}: md sibling unparseable: ${errMsg(err)}`);
      }
    }
  }

  if (fails.length > 0) {
    return { id, label, status: 'fail', issues: [...fails, ...warns] };
  }
  if (warns.length > 0) {
    return { id, label, status: 'warn', issues: warns };
  }
  return { id, label, status: 'pass', detail: `${names.length} ok` };
}

async function checkDesignSmoke(pluginRoot: string): Promise<CheckResult> {
  const label = 'smoke: design session';
  const bin = join(pluginRoot, 'bin', 'ewh.mjs');
  try {
    await fs.access(bin, fs.constants.R_OK);
  } catch {
    return { id: 13, label, status: 'fail', issues: [`${bin}: not readable (see check #2)`] };
  }

  const projectDir = await fs.mkdtemp(join(tmpdir(), 'ewh-smoke-design-'));
  const roots = ['--plugin-root', pluginRoot, '--project-root', projectDir];

  try {
    // Step 1: start design → get runId + shapePath
    const s1 = await spawnCollect(
      process.execPath,
      [bin, 'start', 'design', 'make', 'a', 'smoke', 'rule', ...roots],
      projectDir,
      30_000,
    );
    if (s1.exitCode !== 0) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`start design: exit ${s1.exitCode}: ${(s1.stderr || s1.stdout).trim().slice(0, 200)}`],
      };
    }
    const runId = s1.stdout.match(/--run (\S+)/)?.[1];
    const shapePath = s1.stdout.match(/--result (\S+)/)?.[1];
    if (!runId || !shapePath) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`start design: could not parse runId/shapePath from: ${s1.stdout.trim().slice(0, 300)}`],
      };
    }

    // Mock facilitator: write shape.json
    const shape = {
      description: 'make a smoke rule',
      artifacts: [
        {
          type: 'rule',
          op: 'create',
          name: 'doctor-smoke-rule',
          scope: 'project',
          path: 'rules/doctor-smoke-rule.md',
          description: 'Doctor smoke test rule',
          frontmatter: { name: 'doctor-smoke-rule', description: 'Doctor smoke test rule' },
        },
      ],
    };
    await fs.mkdir(join(shapePath, '..'), { recursive: true });
    await fs.writeFile(shapePath, JSON.stringify(shape, null, 2), 'utf8');

    // Step 2: report shape.json → shape gate
    const s2 = await spawnCollect(
      process.execPath,
      [bin, 'report', '--run', runId, '--step', '0', '--result', shapePath, ...roots],
      projectDir,
      30_000,
    );
    if (s2.exitCode !== 0 || !s2.stdout.startsWith('ACTION: user-prompt')) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`shape gate: expected user-prompt, got exit=${s2.exitCode}: ${(s2.stderr || s2.stdout).trim().slice(0, 200)}`],
      };
    }

    // Step 3: approve shape gate → author instruction
    const s3 = await spawnCollect(
      process.execPath,
      [bin, 'report', '--run', runId, '--step', '0', '--decision', 'yes', ...roots],
      projectDir,
      30_000,
    );
    if (s3.exitCode !== 0 || !s3.stdout.startsWith('ACTION: tool-call')) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`approve shape gate: expected tool-call, got exit=${s3.exitCode}: ${(s3.stderr || s3.stdout).trim().slice(0, 200)}`],
      };
    }
    const stagedPath = s3.stdout.match(/--result (\S+)/)?.[1];
    if (!stagedPath) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`approve shape gate: could not parse stagedPath from: ${s3.stdout.trim().slice(0, 300)}`],
      };
    }

    // Mock author: write staged file
    const stagedContent =
      '---\nname: doctor-smoke-rule\ndescription: Doctor smoke test rule\n---\n\nDoctor smoke rule body.\n';
    await fs.mkdir(join(stagedPath, '..'), { recursive: true });
    await fs.writeFile(stagedPath, stagedContent, 'utf8');

    // Step 4: report staged file → file gate
    const s4 = await spawnCollect(
      process.execPath,
      [bin, 'report', '--run', runId, '--step', '0', '--result', stagedPath, ...roots],
      projectDir,
      30_000,
    );
    if (s4.exitCode !== 0 || !s4.stdout.startsWith('ACTION: user-prompt')) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`file gate: expected user-prompt, got exit=${s4.exitCode}: ${(s4.stderr || s4.stdout).trim().slice(0, 200)}`],
      };
    }

    // Step 5: approve file gate → done (write)
    const s5 = await spawnCollect(
      process.execPath,
      [bin, 'report', '--run', runId, '--step', '0', '--decision', 'yes', ...roots],
      projectDir,
      30_000,
    );
    if (s5.exitCode !== 0 || !s5.stdout.startsWith('ACTION: done')) {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`approve file gate: expected done, got exit=${s5.exitCode}: ${(s5.stderr || s5.stdout).trim().slice(0, 200)}`],
      };
    }

    // Verify final file written
    const finalPath = join(projectDir, '.claude', 'rules', 'doctor-smoke-rule.md');
    try {
      await fs.access(finalPath);
    } catch {
      return {
        id: 13,
        label,
        status: 'fail',
        issues: [`final file not written at ${finalPath}`],
      };
    }

    return { id: 13, label, status: 'pass' };
  } catch (err) {
    return { id: 13, label, status: 'fail', issues: [errMsg(err)] };
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
}

async function checkSmoke(pluginRoot: string): Promise<CheckResult> {
  const label = 'smoke: ewh start list';
  const bin = join(pluginRoot, 'bin', 'ewh.mjs');
  try {
    await fs.access(bin, fs.constants.R_OK);
  } catch {
    return {
      id: 12,
      label,
      status: 'fail',
      issues: [`${bin}: not readable (see check #2)`],
    };
  }
  const projectDir = await fs.mkdtemp(join(tmpdir(), 'ewh-smoke-'));
  try {
    const { stdout, stderr, exitCode } = await spawnCollect(
      process.execPath,
      [bin, 'start', 'list', '--plugin-root', pluginRoot],
      projectDir,
      30_000,
    );
    if (exitCode !== 0) {
      return {
        id: 12,
        label,
        status: 'fail',
        issues: [`node ${bin} exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 200)}`],
      };
    }
    if (!stdout.startsWith('ACTION: done')) {
      return {
        id: 12,
        label,
        status: 'fail',
        issues: [
          `expected output to start with 'ACTION: done'; got: ${stdout.slice(0, 80).replace(/\n/g, ' ')}`,
        ],
      };
    }
    return { id: 12, label, status: 'pass' };
  } catch (err) {
    return { id: 12, label, status: 'fail', issues: [errMsg(err)] };
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
}

function spawnCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`smoke: timed out after ${timeoutMs}ms`));
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
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
