/**
 * CLI entry for the `ewh` binary. Dispatches to the named subcommand.
 *
 * Primary entry points are `start` and `report` (both wired to the full
 * turn protocol). The five builtin subcommands (`list`, `init`, `cleanup`,
 * `create`, `expand-tools`) are also reachable directly — they delegate to
 * `start` with the subcommand name as argv, matching the SKILL.md shim
 * invocation `ewh start "<name> [...]"`.
 */

import { main as startMain } from './commands/start.js';
import { main as reportMain } from './commands/report.js';
import { main as recordToolUseMain } from './commands/record-tool-use.js';

type Cmd = (argv: string[]) => Promise<void>;

const SUBCOMMAND_ALIASES = [
  'list',
  'init',
  'cleanup',
  'create',
  'expand-tools',
  'status',
  'resume',
  'abort',
  'doctor',
] as const;

function aliasTo(name: string): Cmd {
  return async (argv: string[]) => {
    await startMain([name, ...argv]);
  };
}

const COMMANDS: Record<string, Cmd> = {
  start: startMain,
  report: reportMain,
  'record-tool-use': recordToolUseMain,
  ...Object.fromEntries(SUBCOMMAND_ALIASES.map((n) => [n, aliasTo(n)])),
};

async function main(): Promise<void> {
  const [, , name, ...rest] = process.argv;
  if (!name || name === '--help' || name === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`ewh: unknown command '${name}'\n\n${HELP}`);
    process.exit(2);
  }
  await cmd(rest);
}

const HELP = [
  'ewh — Easy Workflow Harness dispatcher (v2 binary)',
  '',
  'Usage:',
  '  ewh start "<name> [args...]"',
  "      Begin a new run. 'name' is a workflow OR a builtin subcommand.",
  '      Prints the first ACTION block.',
  '  ewh report --run <id> --step <i> [flags]',
  '      Report the outcome of the most recent action. Prints the next',
  '      ACTION block.',
  '      Flags:',
  '        --result <path>     result file written by the tool call',
  '        --decision <y|n>    answer to a gate_pending prompt',
  '        --error "<msg>"     tool call failed',
  '        --abort             abort the run',
  '',
  "Builtin subcommands (all alias to 'ewh start <name>'):",
  '  ewh list                        Show the catalog of workflows and subcommands.',
  '  ewh init                        Bootstrap project with Harness Config + .gitignore.',
  '  ewh cleanup [--manage-tasks]    Run or configure cleanup tasks.',
  '  ewh design "<description>"      Design a rule/agent/workflow conversationally.',
  '  ewh expand-tools [description]  Discover and assign agent tools.',
  '  ewh status                      List in-flight and recent runs.',
  '  ewh resume [<run-id>]           Re-emit the pending instruction for a paused run.',
  '  ewh abort [<run-id>]            Mark a run aborted and clear ACTIVE.',
  '  ewh doctor                      Validate plugin + project environment.',
  '',
  'Start flags:',
  '  --trust                 auto-approve structural gates this run',
  '  --yolo                  --trust + auto-skip compliance (not persisted)',
  '  --max-retries N         override max_error_retries for this run',
  '  --save                  persist applied flag values to workflow_settings',
  '  --manage-scripts        list cached scripts for the workflow and gate',
  "  --manage-tasks          for 'cleanup', enter task-management flow",
  '  --no-override           force builtin subcommand when a same-name',
  '                          project workflow exists',
  '  --strict                enable strict drift detection for this run',
  '',
  'Environment:',
  '  CLAUDE_PLUGIN_ROOT   where the plugin (workflows/, agents/, rules/,',
  '                       templates/, skills/doit/list.md) lives.',
  '                       Defaults to the project root.',
  '',
].join('\n');

main().catch((err) => {
  process.stderr.write(`ewh: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
