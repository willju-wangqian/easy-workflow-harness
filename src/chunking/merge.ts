/**
 * Chunk merge for Phase 5 (spec §1c).
 *
 * After every per-chunk worker has written its artifact, the dispatcher
 * concatenates the per-chunk artifacts into the step's declared artifact
 * path. Missing per-chunk artifacts are tolerated (a chunk may legitimately
 * emit no findings) — absent files are recorded with a "(no output)" stub.
 *
 * The anchor used for incremental agents is preserved by stripping it from
 * each chunk before concat so the final artifact is clean.
 */

import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const INCREMENTAL_ANCHOR = '<!-- EWH_APPEND_HERE -->';

export async function writeIncrementalAnchor(
  chunkArtifactPath: string,
  header: string,
): Promise<void> {
  await fs.mkdir(dirname(chunkArtifactPath), { recursive: true });
  const body = `${header.trimEnd()}\n\n${INCREMENTAL_ANCHOR}\n`;
  await fs.writeFile(chunkArtifactPath, body, 'utf8');
}

export type MergeResult = {
  mergedPath: string;
  present: number;
  missing: number;
};

export async function mergeChunkArtifacts(params: {
  chunkArtifactPaths: string[];
  targetArtifact: string;
  projectRoot: string;
  incremental: boolean;
}): Promise<MergeResult> {
  const { chunkArtifactPaths, targetArtifact, projectRoot, incremental } = params;
  const absTarget = resolve(projectRoot, targetArtifact);

  const parts: string[] = [];
  let present = 0;
  let missing = 0;

  for (let i = 0; i < chunkArtifactPaths.length; i++) {
    const path = chunkArtifactPaths[i]!;
    let body: string;
    try {
      body = await fs.readFile(path, 'utf8');
      present += 1;
    } catch {
      body = `_(chunk ${i + 1}: no output on disk)_\n`;
      missing += 1;
    }
    // Strip the incremental anchor so the merged file is readable.
    if (incremental) body = body.split(INCREMENTAL_ANCHOR).join('').trimEnd() + '\n';
    parts.push(`## Chunk ${i + 1}\n\n${body.trimEnd()}\n`);
  }

  const merged = parts.join('\n');
  await fs.mkdir(dirname(absTarget), { recursive: true });
  await fs.writeFile(absTarget, merged, 'utf8');

  return { mergedPath: absTarget, present, missing };
}
