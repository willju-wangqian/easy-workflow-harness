/**
 * Deterministic markdown renderer for workflow contracts (Session 1).
 *
 * Emits the human-facing `workflow.md` summary derived from a
 * `WorkflowContract`. Same input → byte-identical output on every call:
 * stable key order (name, agent, description), no timestamps, no trailing
 * whitespace.
 */

import YAML from 'yaml';
import type { WorkflowContract } from './contract.js';

export function renderWorkflowMd(contract: WorkflowContract): string {
  const frontmatter = YAML.stringify(
    {
      name: contract.name,
      description: contract.description,
    },
    { sortMapEntries: false },
  ).trimEnd();

  const stepsYaml = YAML.stringify(
    contract.steps.map((s) => ({
      name: s.name,
      agent: s.agent,
      description: s.description,
    })),
    { sortMapEntries: false },
  ).trimEnd();

  const lines = [
    '---',
    frontmatter,
    '---',
    '',
    '## Steps',
    '',
    stepsYaml,
    '',
  ];
  return lines.join('\n');
}
