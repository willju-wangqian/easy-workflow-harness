import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runDoctor } from '../src/commands/doctor.js';

/**
 * Scaffold a tmp dir with a plugin layout that passes every check by
 * default; individual tests break a single check to verify detection.
 */
async function scaffoldPlugin(root: string): Promise<void> {
  await fs.mkdir(join(root, 'bin'), { recursive: true });
  await fs.writeFile(join(root, 'bin', 'ewh.mjs'), '#!/usr/bin/env node\n', {
    mode: 0o755,
  });

  await fs.writeFile(
    join(root, 'package.json'),
    JSON.stringify({ engines: { node: '>=18' } }, null, 2),
  );

  await fs.mkdir(join(root, 'hooks'), { recursive: true });
  await fs.writeFile(join(root, 'hooks', 'hooks.json'), '{}\n');

  await fs.mkdir(join(root, 'agents'), { recursive: true });
  await fs.writeFile(
    join(root, 'agents', 'coder.md'),
    '---\nname: coder\n---\n\nbody\n\nAGENT_COMPLETE\n',
  );
  await fs.writeFile(
    join(root, 'agents', 'tester.md'),
    '---\nname: tester\n---\n\nbody\n\nAGENT_COMPLETE\n',
  );

  await fs.mkdir(join(root, 'rules', 'sub'), { recursive: true });
  await fs.writeFile(join(root, 'rules', 'coding.md'), '---\nname: coding\n---\n\nbody\n');
  await fs.writeFile(
    join(root, 'rules', 'sub', 'nested.md'),
    '---\nname: nested\n---\n\nbody\n',
  );

  await fs.mkdir(join(root, 'workflows'), { recursive: true });
  await fs.writeFile(
    join(root, 'workflows', 'demo.md'),
    [
      '---',
      'name: demo',
      'description: demo',
      '---',
      '',
      '## Steps',
      '',
      '- name: plan',
      '  agent: coder',
      '  gate: structural',
      '  rules: [coding]',
      '',
      '- name: test',
      '  agent: tester',
      '  gate: auto',
      '  rules: [nested]',
      '',
    ].join('\n'),
  );
}

describe('runDoctor', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ewh-doctor-'));
    await scaffoldPlugin(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('all-pass scaffold: exit 0, no fails/warns, summary reflects counts', async () => {
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/SUMMARY: 0 fail, 0 warn, 11 pass/);
    expect(r.output).toContain(`✓ node version (${process.version})`);
    expect(r.output).toContain('✓ plugin agents');
    expect(r.output).toContain('✓ plugin rules');
    expect(r.output).toContain('✓ plugin workflows');
    expect(r.output).toContain('✓ project contracts');
    for (const r2 of r.results) expect(r2.status).toBe('pass');
  });

  it('check #2: bin/ewh.mjs missing → fail with path issue', async () => {
    await fs.rm(join(root, 'bin', 'ewh.mjs'));
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 2)!;
    expect(c.status).toBe('fail');
    expect(r.output).toContain('✗ binary present');
    expect(r.output).toMatch(/ewh\.mjs: missing/);
  });

  it('check #3: missing workflows/ dir → fail', async () => {
    await fs.rm(join(root, 'workflows'), { recursive: true });
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 3)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.some((i) => i.includes('workflows/'))).toBe(true);
  });

  it('check #4: .ewh-artifacts probe succeeds (creates dir if absent)', async () => {
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    const c = r.results.find((x) => x.id === 4)!;
    expect(c.status).toBe('pass');
    await fs.access(join(root, '.ewh-artifacts'));
  });

  it('check #5: malformed ewh-state.json → warn (exit 0)', async () => {
    await fs.mkdir(join(root, '.claude'), { recursive: true });
    await fs.writeFile(join(root, '.claude', 'ewh-state.json'), '{ not json');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    const c = r.results.find((x) => x.id === 5)!;
    expect(c.status).toBe('warn');
    expect(r.output).toContain('! ewh-state.json (warning:');
  });

  it('check #5: missing ewh-state.json is a silent pass', async () => {
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    const c = r.results.find((x) => x.id === 5)!;
    expect(c.status).toBe('pass');
    expect(c.detail).toBe('not present');
  });

  it('check #6: CLAUDE.md without Harness Config → warn', async () => {
    await fs.writeFile(join(root, 'CLAUDE.md'), '# project\n\n(no harness config here)\n');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    const c = r.results.find((x) => x.id === 6)!;
    expect(c.status).toBe('warn');
    expect(c.issues?.[0]).toMatch(/## Harness Config/);
  });

  it('check #6: CLAUDE.md with Harness Config → pass', async () => {
    await fs.writeFile(
      join(root, 'CLAUDE.md'),
      '# project\n\n## Harness Config\n\n- Language: ts\n',
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    const c = r.results.find((x) => x.id === 6)!;
    expect(c.status).toBe('pass');
  });

  it('check #7: invalid hooks.json → warn', async () => {
    await fs.writeFile(join(root, 'hooks', 'hooks.json'), 'not json');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    const c = r.results.find((x) => x.id === 7)!;
    expect(c.status).toBe('warn');
  });

  it('check #8: agent missing AGENT_COMPLETE → fail, aggregates offenders', async () => {
    await fs.writeFile(
      join(root, 'agents', 'coder.md'),
      '---\nname: coder\n---\n\nno sentinel here\n',
    );
    await fs.writeFile(
      join(root, 'agents', 'reviewer.md'),
      '---\nname: reviewer\n---\n\nalso no sentinel\n',
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 8)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.length).toBe(2);
    expect(r.output).toContain('✗ plugin agents (2 issues)');
    expect(r.output).toMatch(/agents\/coder\.md: missing AGENT_COMPLETE sentinel/);
    expect(r.output).toMatch(/agents\/reviewer\.md: missing AGENT_COMPLETE sentinel/);
  });

  it('check #8: agent with invalid frontmatter → fail', async () => {
    await fs.writeFile(join(root, 'agents', 'broken.md'), 'no frontmatter at all\n');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 8)!;
    expect(c.issues?.some((i) => i.includes('missing YAML frontmatter'))).toBe(true);
  });

  it('check #9: nested rule with missing name → fail', async () => {
    await fs.writeFile(
      join(root, 'rules', 'sub', 'nested.md'),
      '---\ndescription: no name\n---\n\nbody\n',
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 9)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.[0]).toMatch(/rules\/sub\/nested\.md/);
  });

  it('check #10: workflow references missing agent → fail', async () => {
    await fs.writeFile(
      join(root, 'workflows', 'bad.md'),
      [
        '---',
        'name: bad',
        '---',
        '',
        '## Steps',
        '',
        '- name: x',
        '  agent: nonexistent',
        '  gate: auto',
        '',
      ].join('\n'),
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 10)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.some((i) => i.includes("missing agent 'nonexistent'"))).toBe(true);
  });

  it('check #10: workflow references missing rule → fail', async () => {
    await fs.writeFile(
      join(root, 'workflows', 'bad.md'),
      [
        '---',
        'name: bad',
        '---',
        '',
        '## Steps',
        '',
        '- name: x',
        '  agent: coder',
        '  gate: auto',
        '  rules: [no-such-rule]',
        '',
      ].join('\n'),
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 10)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.some((i) => i.includes("missing rule 'no-such-rule'"))).toBe(true);
  });

  it('check #10: unparseable workflow → fail', async () => {
    await fs.writeFile(join(root, 'workflows', 'broken.md'), 'no frontmatter\n');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 10)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.some((i) => i.includes('workflows/broken.md'))).toBe(true);
  });

  it('warn-only scenario yields exit 0 and "1 warn" in summary', async () => {
    await fs.writeFile(join(root, 'hooks', 'hooks.json'), 'bad');
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/SUMMARY: 0 fail, 1 warn, 10 pass/);
  });

  it('migrated legacy workflow with rules → doctor passes with 0 warn (extras are not drift)', async () => {
    // Simulate the exact output of `ewh migrate` on a legacy workflow that
    // carried `rules: [coding]` against a plugin agent that does not declare
    // `coding` in its default_rules. Extras are additive by design, so drift
    // must not fire.
    const contractsDir = join(root, '.claude', 'ewh-workflows');
    await fs.mkdir(contractsDir, { recursive: true });
    const contract = {
      name: 'legacy-demo',
      description: 'migrated from legacy',
      steps: [
        {
          name: 'plan',
          agent: 'coder',
          description: 'plan the thing',
          gate: 'structural',
          produces: ['.ewh-artifacts/plan.md'],
          context: [{ type: 'rule', ref: 'coding' }],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };
    await fs.writeFile(
      join(contractsDir, 'legacy-demo.json'),
      JSON.stringify(contract, null, 2) + '\n',
    );
    await fs.writeFile(
      join(contractsDir, 'legacy-demo.md'),
      '---\nname: legacy-demo\n---\n\n## Steps\n\n- name: plan\n  agent: coder\n',
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/SUMMARY: 0 fail, 0 warn, 11 pass/);
    const c = r.results.find((x) => x.id === 11)!;
    expect(c.status).toBe('pass');
  });

  it('drift check: step missing an agent default_rule → warn names the remedy', async () => {
    // Give the coder agent a default_rule the step omits.
    await fs.writeFile(
      join(root, 'agents', 'coder.md'),
      '---\nname: coder\ndefault_rules: [coding]\n---\n\nbody\n\nAGENT_COMPLETE\n',
    );
    const contractsDir = join(root, '.claude', 'ewh-workflows');
    await fs.mkdir(contractsDir, { recursive: true });
    const contract = {
      name: 'drift-demo',
      description: 'missing default',
      steps: [
        {
          name: 'plan',
          agent: 'coder',
          description: 'plan',
          gate: 'structural',
          produces: ['.ewh-artifacts/plan.md'],
          context: [],
          requires: [],
          chunked: false,
          script: null,
          script_fallback: 'gate',
        },
      ],
    };
    await fs.writeFile(
      join(contractsDir, 'drift-demo.json'),
      JSON.stringify(contract, null, 2) + '\n',
    );
    await fs.writeFile(
      join(contractsDir, 'drift-demo.md'),
      '---\nname: drift-demo\n---\n\n## Steps\n\n- name: plan\n  agent: coder\n',
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.exitCode).toBe(0);
    const c = r.results.find((x) => x.id === 11)!;
    expect(c.status).toBe('warn');
    expect(c.issues?.[0]).toMatch(/missing agent 'coder' default_rules: \[coding\]/);
    expect(c.issues?.[0]).toMatch(/\/ewh:doit manage drift-demo/);
  });

  it('smoke: skipped by default (11 checks, no smoke IDs)', async () => {
    const r = await runDoctor({ projectRoot: root, pluginRoot: root });
    expect(r.results.length).toBe(11);
    expect(r.results.find((c) => c.id === 12)).toBeUndefined();
    expect(r.results.find((c) => c.id === 13)).toBeUndefined();
    expect(r.output).not.toContain('smoke');
  });

  it('smoke: simple stub emits ACTION: done → smoke list passes, design fails, 13 total', async () => {
    await fs.writeFile(
      join(root, 'bin', 'ewh.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write('ACTION: done\\nCatalog body\\n');\n",
      { mode: 0o755 },
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root, smoke: true });
    expect(r.results.length).toBe(13);
    const cList = r.results.find((x) => x.id === 12)!;
    expect(cList.status).toBe('pass');
    const cDesign = r.results.find((x) => x.id === 13)!;
    expect(cDesign.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('✓ smoke: ewh start list');
    expect(r.output).toContain('✗ smoke: design session');
  });

  it('smoke: multi-step stub → smoke list and design both pass, 13 total', async () => {
    // Stub uses a per-projectDir step counter to simulate the design protocol.
    const stubSrc = [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const args = process.argv.slice(2);',
      "const prIdx = args.indexOf('--project-root');",
      'const projectRoot = prIdx !== -1 ? args[prIdx + 1] : process.cwd();',
      "const stateFile = path.join(projectRoot, '.ewh-stub-step');",
      'let step = 0;',
      "try { step = parseInt(fs.readFileSync(stateFile, 'utf8')); } catch {}",
      'step++;',
      "fs.writeFileSync(stateFile, String(step), 'utf8');",
      "const shapePath = path.join(projectRoot, 'stub-shape.json');",
      "const stagedPath = path.join(projectRoot, 'stub-staged.md');",
      "const finalDir = path.join(projectRoot, '.claude', 'rules');",
      "const finalPath = path.join(finalDir, 'doctor-smoke-rule.md');",
      "const cmd = args[0];",
      "if (cmd === 'start' && !args.includes('design')) {",
      "  process.stdout.write('ACTION: done\\nCatalog body\\n');",
      "} else if (cmd === 'start') {",
      "  process.stdout.write('ACTION: tool-call\\nfacilitator\\nREPORT_WITH: ewh report --run fake --step 0 --result ' + shapePath + '\\n');",
      "} else if (step === 2) {",
      "  process.stdout.write('ACTION: user-prompt\\nshape gate\\nREPORT_WITH: ewh report --run fake --step 0 --decision yes\\n');",
      "} else if (step === 3) {",
      "  process.stdout.write('ACTION: tool-call\\nauthor\\nREPORT_WITH: ewh report --run fake --step 0 --result ' + stagedPath + '\\n');",
      "} else if (step === 4) {",
      "  process.stdout.write('ACTION: user-prompt\\nfile gate\\nREPORT_WITH: ewh report --run fake --step 0 --decision yes\\n');",
      '} else {',
      '  fs.mkdirSync(finalDir, { recursive: true });',
      "  fs.writeFileSync(finalPath, '---\\nname: doctor-smoke-rule\\n---\\nBody.\\n', 'utf8');",
      "  process.stdout.write('ACTION: done\\nWrote 1 artifact\\n');",
      '}',
    ].join('\n');
    await fs.writeFile(join(root, 'bin', 'ewh.mjs'), stubSrc, { mode: 0o755 });
    const r = await runDoctor({ projectRoot: root, pluginRoot: root, smoke: true });
    expect(r.results.length).toBe(13);
    const cList = r.results.find((x) => x.id === 12)!;
    expect(cList.status).toBe('pass');
    const cDesign = r.results.find((x) => x.id === 13)!;
    expect(cDesign.status).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('✓ smoke: ewh start list');
    expect(r.output).toContain('✓ smoke: design session');
  });

  it('smoke: stub bin emitting wrong output → fail', async () => {
    await fs.writeFile(
      join(root, 'bin', 'ewh.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write('unexpected stuff\\n');\n",
      { mode: 0o755 },
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root, smoke: true });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 12)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.[0]).toMatch(/expected output to start with 'ACTION: done'/);
  });

  it('smoke: stub bin exits non-zero → fail', async () => {
    await fs.writeFile(
      join(root, 'bin', 'ewh.mjs'),
      "#!/usr/bin/env node\nprocess.stderr.write('boom\\n'); process.exit(3);\n",
      { mode: 0o755 },
    );
    const r = await runDoctor({ projectRoot: root, pluginRoot: root, smoke: true });
    expect(r.exitCode).toBe(1);
    const c = r.results.find((x) => x.id === 12)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.[0]).toMatch(/exited 3/);
  });

  it('smoke: missing bin → fail with check #2 reference', async () => {
    await fs.rm(join(root, 'bin', 'ewh.mjs'));
    const r = await runDoctor({ projectRoot: root, pluginRoot: root, smoke: true });
    const c = r.results.find((x) => x.id === 12)!;
    expect(c.status).toBe('fail');
    expect(c.issues?.[0]).toMatch(/see check #2/);
  });

  it('project override agent resolves for workflow check #10', async () => {
    // Remove plugin agent and add a project override instead.
    await fs.rm(join(root, 'agents', 'tester.md'));
    const project = await fs.mkdtemp(join(tmpdir(), 'ewh-doctor-proj-'));
    try {
      await fs.mkdir(join(project, '.claude', 'agents'), { recursive: true });
      await fs.writeFile(
        join(project, '.claude', 'agents', 'tester.md'),
        '---\nname: tester\n---\n\nbody\n\nAGENT_COMPLETE\n',
      );
      const r = await runDoctor({ projectRoot: project, pluginRoot: root });
      const c = r.results.find((x) => x.id === 10)!;
      expect(c.status).toBe('pass');
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
