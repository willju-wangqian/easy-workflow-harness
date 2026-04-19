/**
 * Build prompts for the continuation and split phases.
 *
 * Both functions read the original agent prompt from disk and append
 * phase-specific context so the spawned agent knows exactly what to do.
 */

import { promises as fs } from 'node:fs';

export async function buildContinuationPrompt(params: {
  originalPromptPath: string;
  partialOutput: string;
}): Promise<string> {
  const original = await fs.readFile(params.originalPromptPath, 'utf8');
  return [
    original.trimEnd(),
    ``,
    `## Continuation Context`,
    ``,
    `The previous agent run was interrupted before completing (AGENT_COMPLETE sentinel absent).`,
    `Partial output from the interrupted run:`,
    ``,
    `\`\`\``,
    params.partialOutput.trimEnd(),
    `\`\`\``,
    ``,
    `Resume from where the previous run stopped. Complete all remaining work and emit AGENT_COMPLETE as the very last line.`,
  ].join('\n') + '\n';
}

/**
 * Build a prompt for one split chunk.
 *
 * When `items` is empty the original prompt is returned unchanged — this is
 * the "full-task re-run" fallback used when no list items were detected in
 * the partial output.
 */
export async function buildSplitChunkPrompt(params: {
  originalPromptPath: string;
  items: string[];
  chunkIndex: number;
  totalChunks: number;
}): Promise<string> {
  const original = await fs.readFile(params.originalPromptPath, 'utf8');
  const { items, chunkIndex, totalChunks } = params;

  if (items.length === 0) {
    return original;
  }

  return [
    original.trimEnd(),
    ``,
    `## Split Chunk ${chunkIndex + 1} of ${totalChunks}`,
    ``,
    `Process ONLY the following ${items.length} item(s) from the work list:`,
    ``,
    ...items.map((item, i) => `${i + 1}. ${item}`),
    ``,
    `Ignore any items not listed above. Emit AGENT_COMPLETE as the very last line.`,
  ].join('\n') + '\n';
}
