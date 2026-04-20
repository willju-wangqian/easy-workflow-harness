import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildListBody } from '../src/commands/list.js';
import {
  parseCandidates,
  persistCleanupTasks,
  startCleanup,
  continueCleanup,
} from '../src/commands/cleanup.js';
import {
  buildHarnessConfigSection,
  ensureGitignoreEntries,
  replaceOrAppendSection,
  upsertHarnessConfig,
} from '../src/commands/init.js';
import {
  buildOverrideFile,
  persistAgentTools,
  readExistingAgentTools,
  readProposal,
  generateAgentOverrides,
} from '../src/commands/expand-tools.js';
import {
  readEwhStateFile,
  writeEwhStateFile,
} from '../src/state/workflow-settings.js';
import type { RunState, SubcommandState } from '../src/state/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'ewh-subcommands-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(overrides?: Partial<RunState>): RunState {
  return {
    run_id: 'test',
    workflow: 'cleanup',
    raw_argv: 'cleanup',
    current_step_index: 0,
    steps: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    subcommand: 'cleanup',
    ...overrides,
  };
}

// ── list ────────────────────────────────────────────────────────────────

describe('list subcommand', () => {
  it('reads list.md and omits footer when no overrides exist', async () => {
    const pluginRoot = tmpDir;
    const projectRoot = tmpDir;
    await fs.mkdir(join(pluginRoot, 'skills', 'doit'), { recursive: true });
    await fs.writeFile(
      join(pluginRoot, 'skills', 'doit', 'list.md'),
      'Catalog static content\n',
      'utf8',
    );

    const body = await buildListBody({ pluginRoot, projectRoot });
    expect(body).toContain('Catalog static content');
    expect(body).not.toContain('Project overrides:');
  });

  it('appends override footer for project-level workflows/rules/agents', async () => {
    const pluginRoot = tmpDir;
    const projectRoot = tmpDir;
    await fs.mkdir(join(pluginRoot, 'skills', 'doit'), { recursive: true });
    await fs.writeFile(join(pluginRoot, 'skills', 'doit', 'list.md'), 'HEADER\n');

    await fs.mkdir(join(projectRoot, '.claude', 'workflows'), { recursive: true });
    await fs.writeFile(join(projectRoot, '.claude', 'workflows', 'my-flow.md'), '---\n');

    await fs.mkdir(join(projectRoot, '.claude', 'rules', 'nested'), { recursive: true });
    await fs.writeFile(join(projectRoot, '.claude', 'rules', 'a.md'), '---\n');
    await fs.writeFile(join(projectRoot, '.claude', 'rules', 'nested', 'b.md'), '---\n');

    await fs.mkdir(join(projectRoot, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(join(projectRoot, '.claude', 'agents', 'coder.md'), '---\n');

    const body = await buildListBody({ pluginRoot, projectRoot });
    expect(body).toContain('HEADER');
    expect(body).toContain('Project overrides:');
    expect(body).toContain('workflows: my-flow');
    expect(body).toContain('rules:     a, b');
    expect(body).toContain('agents:    coder');
  });

  it('falls back to inline catalog when list.md is missing', async () => {
    const body = await buildListBody({ pluginRoot: tmpDir, projectRoot: tmpDir });
    expect(body).toMatch(/Easy Workflow Harness — Available Commands/);
  });
});

// ── cleanup ──────────────────────────────────────────────────────────────

describe('cleanup subcommand', () => {
  it('emits "no tasks" message when cleanup_tasks is empty', async () => {
    const r = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    expect(r.state).toBeUndefined();
    expect(r.instruction.kind).toBe('done');
    expect(r.instruction.body).toMatch(/--manage-tasks/);
  });

  it('emits a bash instruction for the first task when tasks are configured', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'run-tests', command: 'npm test', description: 'run tests' },
      { name: 'lint', command: 'eslint .' },
    ]);
    const r = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    expect(r.state).toMatchObject({
      kind: 'cleanup',
      phase: 'running',
      index: 0,
    });
    expect(r.instruction.kind).toBe('bash');
    expect(r.instruction.body).toContain('run-tests');
    expect(r.instruction.body).toContain('npm test');
  });

  it('advances to the next task on result report', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'a', command: 'echo 1' },
      { name: 'b', command: 'echo 2' },
    ]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    const next = await continueCleanup(
      run,
      { kind: 'result', step_index: 0 },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(next.kind).toBe('bash');
    expect(next.body).toContain('b');
    const state = run.subcommand_state as Extract<SubcommandState, { kind: 'cleanup' }>;
    expect(state.passed).toBe(1);
    expect(state.index).toBe(1);
  });

  it('gates with user-prompt on task error, skips on --decision yes', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'a', command: 'exit 1' },
      { name: 'b', command: 'echo 2' },
    ]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    const gate = await continueCleanup(
      run,
      { kind: 'error', step_index: 0, message: 'boom' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(gate.kind).toBe('user-prompt');
    expect(gate.body).toContain('boom');
    const failedState = run.subcommand_state as Extract<
      SubcommandState,
      { kind: 'cleanup'; phase: 'task-failed' }
    >;
    expect(failedState.phase).toBe('task-failed');
    expect(failedState.failed).toBe(1);

    const resumed = await continueCleanup(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(resumed.kind).toBe('bash');
    expect(resumed.body).toContain('b');
    const running = run.subcommand_state as Extract<SubcommandState, { kind: 'cleanup' }>;
    expect(running.skipped).toBe(1);
    expect(running.index).toBe(1);
  });

  it('parses cleanup-candidates JSON file', async () => {
    const path = join(tmpDir, 'candidates.json');
    await fs.writeFile(
      path,
      JSON.stringify([
        { name: 'a', command: 'foo', description: 'run foo' },
        { name: 'bad' }, // missing command — skipped
        { name: 'b', command: 'bar' },
      ]),
    );
    const parsed = await parseCandidates(path);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: 'a', command: 'foo', description: 'run foo' });
    expect(parsed[1]).toEqual({ name: 'b', command: 'bar', description: undefined });
  });

  it('persistCleanupTasks writes to .claude/ewh-state.json', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'only', command: 'cmd' },
    ]);
    const raw = await readEwhStateFile(tmpDir);
    expect(raw.cleanup_tasks).toEqual([
      { name: 'only', command: 'cmd' },
    ]);
  });

  it('gates task failure with decision=no (continue without skip++)', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'a', command: 'exit 1' },
      { name: 'b', command: 'echo 2' },
    ]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    await continueCleanup(
      run,
      { kind: 'error', step_index: 0, message: 'boom' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    const resumed = await continueCleanup(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(resumed.kind).toBe('bash');
    const state = run.subcommand_state as Extract<SubcommandState, { kind: 'cleanup' }>;
    expect(state.skipped).toBe(0);
    expect(state.index).toBe(1);
  });

  it('completes with summary after the last task', async () => {
    await persistCleanupTasks(tmpDir, [
      { name: 'solo', command: 'echo' },
    ]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    const final = await continueCleanup(
      run,
      { kind: 'result', step_index: 0 },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(final.kind).toBe('done');
    expect(final.body).toMatch(/1 passed/);
  });

  it('throws on non-decision report during task-failed phase', async () => {
    await persistCleanupTasks(tmpDir, [{ name: 'a', command: 'exit 1' }]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    await continueCleanup(
      run,
      { kind: 'error', step_index: 0, message: 'boom' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    await expect(
      continueCleanup(
        run,
        { kind: 'result', step_index: 0 },
        { projectRoot: tmpDir, pluginRoot: tmpDir },
      ),
    ).rejects.toThrow(/expected --decision during task-failed/);
  });

  it('throws on unexpected report kind during running phase', async () => {
    await persistCleanupTasks(tmpDir, [{ name: 'a', command: 'ok' }]);
    const start = await startCleanup({ projectRoot: tmpDir, pluginRoot: tmpDir });
    const run = makeRun({ subcommand_state: start.state });
    await expect(
      continueCleanup(
        run,
        { kind: 'abort' },
        { projectRoot: tmpDir, pluginRoot: tmpDir },
      ),
    ).rejects.toThrow(/unexpected report kind abort/);
  });

  it('throws when subcommand_state is missing or wrong kind', async () => {
    const run = makeRun({ subcommand_state: undefined });
    await expect(
      continueCleanup(run, { kind: 'abort' }, { projectRoot: tmpDir, pluginRoot: tmpDir }),
    ).rejects.toThrow(/non-cleanup subcommand state/);
  });

  it('--manage-tasks emits a scan bash instruction', async () => {
    const r = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    expect(r.instruction.kind).toBe('bash');
    expect(r.instruction.body).toContain('package.json');
  });

  it('--manage-tasks scan → propose → save flow', async () => {
    const path = join(tmpDir, 'candidates.json');
    await fs.writeFile(
      path,
      JSON.stringify([
        { name: 'fmt', command: 'prettier --write .' },
        { name: 'lint', command: 'eslint .' },
      ]),
    );
    const start = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    const run = makeRun({ subcommand_state: start.state });
    const propose = await continueCleanup(
      run,
      { kind: 'result', step_index: 0, result_path: path },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(propose.kind).toBe('user-prompt');
    expect(propose.body).toContain('Proposed cleanup tasks');
    const confirm = await continueCleanup(
      run,
      { kind: 'decision', step_index: 0, decision: 'yes' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(confirm.kind).toBe('done');
    expect(confirm.body).toContain('Saved 2 cleanup task(s)');
    const file = await readEwhStateFile(tmpDir);
    expect(file.cleanup_tasks).toHaveLength(2);
  });

  it('--manage-tasks decision=no leaves tasks unchanged', async () => {
    const path = join(tmpDir, 'candidates.json');
    await fs.writeFile(path, JSON.stringify([{ name: 'x', command: 'y' }]));
    const start = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    const run = makeRun({ subcommand_state: start.state });
    await continueCleanup(
      run,
      { kind: 'result', step_index: 0, result_path: path },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    const decline = await continueCleanup(
      run,
      { kind: 'decision', step_index: 0, decision: 'no' },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    expect(decline.kind).toBe('done');
    expect(decline.body).toContain('unchanged');
  });

  it('--manage-tasks scan error throws', async () => {
    const start = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    const run = makeRun({ subcommand_state: start.state });
    await expect(
      continueCleanup(
        run,
        { kind: 'error', step_index: 0, message: 'sigh' },
        { projectRoot: tmpDir, pluginRoot: tmpDir },
      ),
    ).rejects.toThrow(/manage-tasks scan failed/);
  });

  it('--manage-tasks scan with no --result throws', async () => {
    const start = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    const run = makeRun({ subcommand_state: start.state });
    await expect(
      continueCleanup(
        run,
        { kind: 'result', step_index: 0 },
        { projectRoot: tmpDir, pluginRoot: tmpDir },
      ),
    ).rejects.toThrow(/expected --result <path>/);
  });

  it('--manage-tasks propose phase throws on non-decision', async () => {
    const path = join(tmpDir, 'c.json');
    await fs.writeFile(path, JSON.stringify([{ name: 'x', command: 'y' }]));
    const start = await startCleanup({
      projectRoot: tmpDir,
      pluginRoot: tmpDir,
      manageTasks: true,
    });
    const run = makeRun({ subcommand_state: start.state });
    await continueCleanup(
      run,
      { kind: 'result', step_index: 0, result_path: path },
      { projectRoot: tmpDir, pluginRoot: tmpDir },
    );
    await expect(
      continueCleanup(
        run,
        { kind: 'result', step_index: 0 },
        { projectRoot: tmpDir, pluginRoot: tmpDir },
      ),
    ).rejects.toThrow(/expected --decision/);
  });
});

// ── init ─────────────────────────────────────────────────────────────────

describe('init subcommand', () => {
  it('builds a Harness Config section from scan results', () => {
    const section = buildHarnessConfigSection({
      language: 'Python',
      test_command: 'pytest',
      check_command: 'ruff check .',
    });
    expect(section).toContain('## Harness Config');
    expect(section).toContain('- Language: Python');
    expect(section).toContain('- Test command: pytest');
    expect(section).toContain('- Source pattern: none');
  });

  it('replaceOrAppendSection appends to an empty file', () => {
    const out = replaceOrAppendSection('', '## Harness Config\n- Language: Go\n');
    expect(out).toMatch(/^## Harness Config/);
  });

  it('replaceOrAppendSection appends after other content with a blank line separator', () => {
    const existing = '# Project\n\nSome intro.';
    const out = replaceOrAppendSection(existing, '## Harness Config\n- Language: Go');
    expect(out).toContain('Some intro.');
    expect(out).toContain('## Harness Config');
    expect(out.indexOf('## Harness Config')).toBeGreaterThan(
      out.indexOf('Some intro.'),
    );
  });

  it('replaceOrAppendSection replaces an existing section in place', () => {
    const existing = [
      '# Project',
      '',
      '## Harness Config',
      '',
      '- Language: Python',
      '',
      '## Next Section',
      '',
      'tail',
    ].join('\n');
    const out = replaceOrAppendSection(
      existing,
      '## Harness Config\n- Language: Go',
    );
    expect(out).toContain('- Language: Go');
    expect(out).not.toContain('- Language: Python');
    expect(out).toContain('## Next Section');
    expect(out).toContain('tail');
  });

  it('upsertHarnessConfig creates CLAUDE.md if absent', async () => {
    await upsertHarnessConfig(tmpDir, '## Harness Config\n- Language: Go\n');
    const body = await fs.readFile(join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(body).toContain('- Language: Go');
  });

  it('ensureGitignoreEntries adds missing lines and is idempotent', async () => {
    await ensureGitignoreEntries(tmpDir);
    let body = await fs.readFile(join(tmpDir, '.gitignore'), 'utf8');
    expect(body).toContain('.ewh-artifacts/');
    expect(body).toContain('.claude/ewh-state.json');

    await ensureGitignoreEntries(tmpDir);
    body = await fs.readFile(join(tmpDir, '.gitignore'), 'utf8');
    expect(body.match(/\.ewh-artifacts\//g)?.length).toBe(1);
  });

  it('ensureGitignoreEntries preserves existing entries', async () => {
    await fs.writeFile(join(tmpDir, '.gitignore'), 'node_modules\n.ewh-artifacts/\n');
    await ensureGitignoreEntries(tmpDir);
    const body = await fs.readFile(join(tmpDir, '.gitignore'), 'utf8');
    expect(body).toContain('node_modules');
    expect(body).toContain('.claude/ewh-state.json');
    expect(body.match(/\.ewh-artifacts\//g)?.length).toBe(1);
  });
});

// ── expand-tools ────────────────────────────────────────────────────────

describe('expand-tools subcommand', () => {
  it('readProposal validates and normalizes assignments', async () => {
    const path = join(tmpDir, 'proposal.json');
    await fs.writeFile(
      path,
      JSON.stringify({
        source: 'Serena MCP',
        assignments: {
          coder: ['mcp__serena__find_symbol', 'mcp__serena__replace_symbol_body'],
          bogus: 'not-an-array',
        },
      }),
    );
    const p = await readProposal(path);
    expect(p.source).toBe('Serena MCP');
    expect(Object.keys(p.assignments)).toEqual(['coder']);
    expect(p.assignments.coder).toHaveLength(2);
  });

  it('readProposal throws if assignments missing or empty', async () => {
    const path = join(tmpDir, 'bad.json');
    await fs.writeFile(path, JSON.stringify({ source: 'x', assignments: {} }));
    await expect(readProposal(path)).rejects.toThrow(/no valid agent assignments/);
  });

  it('persistAgentTools merges with existing entries', async () => {
    await writeEwhStateFile(tmpDir, {
      agent_tools: {
        coder: { add: ['existing-tool'], source: 'Legacy', configured_at: '2025-01-01' },
      },
    });
    const merged = await persistAgentTools(tmpDir, {
      source: 'Serena MCP',
      assignments: {
        coder: ['new-tool', 'existing-tool'],
        reviewer: ['review-tool'],
      },
    });
    expect(merged.coder!.add).toEqual(['existing-tool', 'new-tool']);
    expect(merged.coder!.source).toBe('Serena MCP');
    expect(merged.reviewer!.add).toEqual(['review-tool']);

    const stateOnDisk = await readExistingAgentTools(tmpDir);
    expect(stateOnDisk.coder!.add).toEqual(['existing-tool', 'new-tool']);
  });

  it('buildOverrideFile produces the correct frontmatter', () => {
    const out = buildOverrideFile('coder', ['Read', 'Write', 'mcp__x']);
    expect(out).toContain('name: coder');
    expect(out).toContain('extends: ewh:coder');
    expect(out).toContain('  - Read');
    expect(out).toContain('  - Write');
    expect(out).toContain('  - mcp__x');
  });

  it('readProposal throws when JSON is not an object', async () => {
    const path = join(tmpDir, 'arr.json');
    await fs.writeFile(path, JSON.stringify([1, 2, 3]));
    await expect(readProposal(path)).rejects.toThrow(/not a JSON object/);
  });

  it('readProposal throws when assignments is missing or malformed', async () => {
    const path = join(tmpDir, 'noa.json');
    await fs.writeFile(path, JSON.stringify({ source: 'x' }));
    await expect(readProposal(path)).rejects.toThrow(/missing or malformed 'assignments'/);

    const path2 = join(tmpDir, 'arr2.json');
    await fs.writeFile(path2, JSON.stringify({ assignments: ['not', 'obj'] }));
    await expect(readProposal(path2)).rejects.toThrow(/missing or malformed 'assignments'/);
  });

  it('readExistingAgentTools returns empty object when state missing', async () => {
    const tools = await readExistingAgentTools(tmpDir);
    expect(tools).toEqual({});
  });

  it('persistAgentTools with no existing state initialises fresh', async () => {
    const merged = await persistAgentTools(tmpDir, {
      assignments: { coder: ['a-tool'] },
    });
    expect(merged.coder!.add).toEqual(['a-tool']);
    expect(merged.coder!.source).toBeUndefined();
    expect(merged.coder!.configured_at).toBeDefined();
  });

  it('persistAgentTools preserves existing source when proposal has none', async () => {
    await writeEwhStateFile(tmpDir, {
      agent_tools: {
        reviewer: { add: ['old'], source: 'Legacy', configured_at: '2024-01-01' },
      },
    });
    const merged = await persistAgentTools(tmpDir, {
      assignments: { reviewer: ['new'] },
    });
    expect(merged.reviewer!.source).toBe('Legacy');
  });

  it('generateAgentOverrides skips agents not in merged map', async () => {
    const out = await generateAgentOverrides(tmpDir, tmpDir, ['ghost'], {});
    expect(out).toEqual([]);
  });

  it('generateAgentOverrides handles a plugin agent that cannot be loaded (no base tools)', async () => {
    const merged = { mystery: { add: ['x'] } };
    const out = await generateAgentOverrides(tmpDir, tmpDir, ['mystery'], merged);
    expect(out).toHaveLength(1);
    const content = await fs.readFile(
      join(tmpDir, '.claude', 'agents', 'mystery.md'),
      'utf8',
    );
    expect(content).toContain('- x');
  });

  it('generateAgentOverrides writes a file per agent with union of plugin + expanded tools', async () => {
    const pluginRoot = tmpDir;
    const projectRoot = tmpDir;
    await fs.mkdir(join(pluginRoot, 'agents'), { recursive: true });
    await fs.writeFile(
      join(pluginRoot, 'agents', 'coder.md'),
      [
        '---',
        'name: coder',
        'description: code',
        'model: sonnet',
        'tools: [Read, Write]',
        'maxTurns: 10',
        '---',
        '',
        'body',
      ].join('\n'),
      'utf8',
    );
    const merged = {
      coder: { add: ['mcp__serena__find_symbol'], source: 'Serena MCP' },
    };
    const result = await generateAgentOverrides(projectRoot, pluginRoot, ['coder'], merged);
    expect(result).toHaveLength(1);
    const out = await fs.readFile(join(projectRoot, '.claude', 'agents', 'coder.md'), 'utf8');
    expect(out).toContain('extends: ewh:coder');
    expect(out).toContain('- Read');
    expect(out).toContain('- Write');
    expect(out).toContain('- mcp__serena__find_symbol');
  });
});
