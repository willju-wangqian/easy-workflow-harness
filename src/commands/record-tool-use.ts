/**
 * `ewh record-tool-use --event <name> [--project-root <dir>]`
 *
 * Called by hook commands (SubagentStart, SubagentStop, PostToolUse).
 * Reads JSON from stdin, finds the active run, and appends a JSONL record
 * to `.ewh-artifacts/<run-dir>/turn-log.jsonl`.
 */

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'node:fs/promises';

async function findActiveRunDir(projectRoot: string): Promise<string | null> {
  const artifactsDir = join(projectRoot, '.ewh-artifacts');
  // glob for ACTIVE markers
  let matches: string[] = [];
  try {
    const iter = glob('*/ACTIVE', { cwd: artifactsDir });
    for await (const m of iter) {
      matches.push(m);
    }
  } catch {
    return null;
  }
  if (matches.length === 0) return null;
  // Use the first match; the ACTIVE marker file name includes run-<id>/ACTIVE
  const first = matches[0]!;
  // first is like "run-abc123/ACTIVE"
  const runDirName = first.split('/')[0]!;
  return join(artifactsDir, runDirName);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      event: { type: 'string' },
      'project-root': { type: 'string' },
    },
    strict: false,
  });

  const eventName = values.event as string | undefined;
  if (!eventName) {
    process.stderr.write('record-tool-use: --event is required\n');
    return;
  }

  const projectRoot =
    (values['project-root'] as string | undefined) ??
    process.env.CLAUDE_PROJECT_ROOT ??
    process.cwd();

  const stdinText = await readStdin();
  let stdinJson: Record<string, unknown> = {};
  try {
    stdinJson = JSON.parse(stdinText) as Record<string, unknown>;
  } catch {
    // malformed stdin — proceed with empty object
  }

  const runDir = await findActiveRunDir(projectRoot);
  if (!runDir) {
    // No active run — exit silently
    return;
  }

  const ts = new Date().toISOString();
  let record: Record<string, unknown>;

  if (eventName === 'SubagentStart') {
    const toolInput = stdinJson.tool_input as Record<string, unknown> | undefined;
    record = {
      event: 'SubagentStart',
      ts,
      tool: 'Agent',
      ...(toolInput?.subagent_type !== undefined ? { subagent_type: toolInput.subagent_type } : {}),
      ...(toolInput?.description !== undefined ? { description: toolInput.description } : {}),
    };
  } else if (eventName === 'SubagentStop') {
    record = { event: 'SubagentStop', ts, tool: 'Agent' };
  } else if (eventName === 'PostToolUse') {
    const toolName = (stdinJson.tool_name as string | undefined) ?? 'unknown';
    record = { event: 'PostToolUse', ts, tool: toolName };
  } else {
    // Unknown event — exit silently
    return;
  }

  const logPath = join(runDir, 'turn-log.jsonl');
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(logPath, line, 'utf8');
}
