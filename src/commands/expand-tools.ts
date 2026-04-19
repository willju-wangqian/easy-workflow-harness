/**
 * `ewh expand-tools` — discover MCP tools and persist per-agent tool
 * expansions.
 *
 * Multi-turn:
 *   1. discover — bash ask the LLM to list available MCP tools to a file.
 *   2. propose — user-prompt asks the LLM to author a proposal JSON matching
 *      the user's stated intent, and write it to a scratch file.
 *   3. confirm — binary reads proposal, previews target agents, asks
 *      --decision yes/no.
 *   4. On yes — merge `agent_tools` into `.claude/ewh-state.json` and
 *      (re)generate `.claude/agents/<name>.md` override stubs.
 *
 * Rerun semantics: existing `agent_tools` entries are merged with new ones
 * (union of tool lists per agent). Removing entries remains a manual edit
 * of `.claude/ewh-state.json` followed by regeneration.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentToolEntry,
  Instruction,
  Report,
  RunState,
  SubcommandState,
} from '../state/types.js';
import {
  readEwhStateFile,
  writeEwhStateFile,
} from '../state/workflow-settings.js';
import { loadAgent } from '../workflow/agent-loader.js';

export type ExpandStartOptions = {
  projectRoot: string;
  pluginRoot: string;
  description?: string;
};

export type ExpandResult = {
  state: SubcommandState | undefined;
  instruction: Instruction;
};

export async function startExpandTools(
  opts: ExpandStartOptions,
): Promise<ExpandResult> {
  const toolsPath = toolsScratchPath(opts.projectRoot);
  const existing = await readExistingAgentTools(opts.projectRoot);
  const state: SubcommandState = { kind: 'expand-tools', phase: 'discover' };
  const intentLine = opts.description
    ? `User intent: ${opts.description}`
    : 'User intent: (none supplied — ask the user if ambiguous)';
  const existingSummary =
    Object.keys(existing).length > 0
      ? [
          '',
          'Existing expansions (new tools will be merged as a union):',
          ...Object.entries(existing).map(
            ([agent, v]) =>
              `  ${agent} (${v.source ?? 'unknown source'}): ${v.add.length} tool(s)`,
          ),
        ].join('\n')
      : '';
  return {
    state,
    instruction: {
      kind: 'bash',
      body: [
        intentLine,
        existingSummary,
        '',
        'Enumerate MCP tools currently available in this session (names',
        `starting with \`mcp__\`). Write the newline-separated list to:`,
        `  ${toolsPath}`,
        '',
        `Then: ewh report --run <id> --step 0 --result ${toolsPath}`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    },
  };
}

export type ExpandContinueOptions = {
  projectRoot: string;
  pluginRoot: string;
};

export async function continueExpandTools(
  run: RunState,
  report: Report,
  opts: ExpandContinueOptions,
): Promise<Instruction> {
  const sub = run.subcommand_state;
  if (!sub || sub.kind !== 'expand-tools') {
    throw new Error('expand-tools report called with non-expand subcommand state');
  }
  if (sub.phase === 'discover') {
    if (report.kind === 'error') throw new Error(`expand-tools discover: ${report.message}`);
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('expand-tools discover: expected --result <path>');
    }
    const proposalPath = proposalScratchPath(opts.projectRoot);
    run.subcommand_state = {
      kind: 'expand-tools',
      phase: 'propose',
      tools_path: report.result_path,
    };
    return {
      kind: 'user-prompt',
      body: [
        `Available MCP tools are listed in: ${report.result_path}`,
        '',
        'Author a proposal JSON that matches the user\'s intent and write it to:',
        `  ${proposalPath}`,
        '',
        'Schema:',
        '  {',
        '    "source": "<name of the source, e.g. Serena MCP>",',
        '    "assignments": {',
        '      "<agent-name>": ["mcp__...","mcp__..."]',
        '    }',
        '  }',
        '',
        'Rules:',
        '  - Only propose tools relevant to the stated intent.',
        '  - Read-only agents (reviewer/scanner/compliance) must NOT receive',
        '    write tools. Confirm with the user before breaking that.',
        '  - Use short, descriptive source name — one source per proposal.',
        '',
        `Then: ewh report --run ${run.run_id} --step 0 --result ${proposalPath}`,
      ].join('\n'),
    };
  }
  if (sub.phase === 'propose') {
    if (report.kind === 'error') throw new Error(`expand-tools propose: ${report.message}`);
    if (report.kind !== 'result' || !report.result_path) {
      throw new Error('expand-tools propose: expected --result <path>');
    }
    const proposal = await readProposal(report.result_path);
    run.subcommand_state = {
      kind: 'expand-tools',
      phase: 'confirm',
      proposal_path: report.result_path,
    };
    return {
      kind: 'user-prompt',
      body: [
        `Proposed tool expansion (source: ${proposal.source ?? 'unspecified'}):`,
        '',
        ...Object.entries(proposal.assignments).map(
          ([agent, tools]) => `  ${agent}: +${tools.length} tool(s)`,
        ),
        '',
        'On approval the binary will:',
        '  - merge these into .claude/ewh-state.json under agent_tools',
        '  - (re)generate .claude/agents/<agent>.md override stubs that',
        '    extend the plugin agent and include the union of existing',
        '    + expanded tools.',
        '',
        `  confirm: ewh report --run ${run.run_id} --step 0 --decision yes`,
        `  abort:   ewh report --run ${run.run_id} --abort`,
      ].join('\n'),
      report_with: `ewh report --run ${run.run_id} --step 0 --decision yes`,
    };
  }
  if (sub.phase === 'confirm') {
    if (report.kind !== 'decision') {
      throw new Error(`expand-tools confirm: expected --decision, got ${report.kind}`);
    }
    if (report.decision === 'no') {
      run.subcommand_state = undefined;
      return { kind: 'done', body: 'expand-tools aborted; no files changed.' };
    }
    const proposal = await readProposal(sub.proposal_path);
    const merged = await persistAgentTools(opts.projectRoot, proposal);
    const generated = await generateAgentOverrides(
      opts.projectRoot,
      opts.pluginRoot,
      Object.keys(proposal.assignments),
      merged,
    );
    run.subcommand_state = undefined;
    return {
      kind: 'done',
      body: [
        'Tool expansion complete:',
        ...generated.map(
          (g) => `  ${g.agent}: ${g.toolsAdded} tool(s) → ${g.path}`,
        ),
        'Persisted in .claude/ewh-state.json under agent_tools.',
      ].join('\n'),
    };
  }
  throw new Error(`expand-tools: unhandled phase ${(sub as { phase: string }).phase}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

export function toolsScratchPath(projectRoot: string): string {
  return join(projectRoot, '.ewh-artifacts', 'expand-tools-available.txt');
}

export function proposalScratchPath(projectRoot: string): string {
  return join(projectRoot, '.ewh-artifacts', 'expand-tools-proposal.json');
}

export type ExpandProposal = {
  source?: string;
  assignments: Record<string, string[]>;
};

export async function readProposal(path: string): Promise<ExpandProposal> {
  const content = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expand-tools proposal ${path} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const source = typeof obj.source === 'string' ? obj.source : undefined;
  const rawAssign = obj.assignments;
  if (!rawAssign || typeof rawAssign !== 'object' || Array.isArray(rawAssign)) {
    throw new Error(`expand-tools proposal: missing or malformed 'assignments' object`);
  }
  const assignments: Record<string, string[]> = {};
  for (const [agent, tools] of Object.entries(rawAssign as Record<string, unknown>)) {
    if (!Array.isArray(tools)) continue;
    const names = tools.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (names.length > 0) assignments[agent] = names;
  }
  if (Object.keys(assignments).length === 0) {
    throw new Error('expand-tools proposal: no valid agent assignments found');
  }
  return { source, assignments };
}

export async function readExistingAgentTools(
  projectRoot: string,
): Promise<Record<string, AgentToolEntry>> {
  const state = await readEwhStateFile(projectRoot);
  return state.agent_tools ?? {};
}

/** Merge `proposal` into ewh-state.json. Returns the merged `agent_tools` map. */
export async function persistAgentTools(
  projectRoot: string,
  proposal: ExpandProposal,
): Promise<Record<string, AgentToolEntry>> {
  const state = await readEwhStateFile(projectRoot);
  const current = state.agent_tools ?? {};
  const today = new Date().toISOString().slice(0, 10);
  for (const [agent, tools] of Object.entries(proposal.assignments)) {
    const existing = current[agent] ?? { add: [] };
    const unionTools = Array.from(new Set([...(existing.add ?? []), ...tools]));
    current[agent] = {
      add: unionTools,
      source: proposal.source ?? existing.source,
      configured_at: today,
    };
  }
  state.agent_tools = current;
  await writeEwhStateFile(projectRoot, state);
  return current;
}

export type GeneratedOverride = {
  agent: string;
  path: string;
  toolsAdded: number;
};

export async function generateAgentOverrides(
  projectRoot: string,
  pluginRoot: string,
  agents: string[],
  merged: Record<string, AgentToolEntry>,
): Promise<GeneratedOverride[]> {
  const out: GeneratedOverride[] = [];
  for (const agent of agents) {
    const entry = merged[agent];
    if (!entry) continue;
    const baseTools = await readPluginAgentTools(pluginRoot, agent);
    const allTools = Array.from(new Set([...baseTools, ...entry.add]));
    const path = join(projectRoot, '.claude', 'agents', `${agent}.md`);
    await fs.mkdir(dirname(path), { recursive: true });
    const content = buildOverrideFile(agent, allTools);
    await fs.writeFile(path, content, 'utf8');
    out.push({ agent, path, toolsAdded: entry.add.length });
  }
  return out;
}

async function readPluginAgentTools(
  pluginRoot: string,
  agent: string,
): Promise<string[]> {
  try {
    const loaded = await loadAgent(agent, pluginRoot, pluginRoot);
    return loaded.tools ?? [];
  } catch {
    return [];
  }
}

export function buildOverrideFile(agent: string, tools: string[]): string {
  const toolList = tools.map((t) => `  - ${t}`).join('\n');
  return [
    '---',
    `name: ${agent}`,
    `extends: ewh:${agent}`,
    `tools:`,
    toolList,
    '---',
    '',
  ].join('\n');
}
