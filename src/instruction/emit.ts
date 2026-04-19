/**
 * Format an Instruction into the `ACTION:` block the SKILL.md shim reads.
 *
 * Contract per spec §Turn Protocol:
 *
 *     ACTION: <tool-call | user-prompt | bash | done>
 *     <body — what to do, prose>
 *     REPORT_WITH: ewh report --run <id> --step <id> [flags]
 *
 * `done` omits REPORT_WITH.
 */

import type { Instruction } from '../state/types.js';

export function formatInstruction(instr: Instruction): string {
  const lines = [`ACTION: ${instr.kind}`, instr.body.trimEnd()];
  if (instr.kind !== 'done' && instr.report_with) {
    lines.push(`REPORT_WITH: ${instr.report_with}`);
  }
  return lines.join('\n') + '\n';
}
