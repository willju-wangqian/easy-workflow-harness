/**
 * Chunk planning for Phase 5 (spec §1c).
 *
 * Enumerates files matching include/exclude glob patterns and splits them
 * into fixed-size chunks for parallel agent dispatch. Patterns are supplied
 * by the user at `chunk_plan` and persisted under `chunked_patterns` in
 * `.claude/ewh-state.json`.
 */

import { glob } from 'glob';
import type { ChunkedPatterns } from '../state/workflow-settings.js';

export const DEFAULT_CHUNK_SIZE = 8;

export async function enumerateFiles(
  patterns: ChunkedPatterns,
  projectRoot: string,
): Promise<string[]> {
  if (patterns.include.length === 0) return [];
  const matches = await glob(patterns.include, {
    cwd: projectRoot,
    ignore: patterns.exclude ?? [],
    nodir: true,
    dot: false,
  });
  return [...matches].sort();
}

export function splitIntoChunks(
  files: string[],
  size: number = DEFAULT_CHUNK_SIZE,
): string[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  if (files.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += size) {
    chunks.push(files.slice(i, i + size));
  }
  return chunks;
}

/**
 * Parse a user-supplied patterns file. Accepted forms:
 *   { "include": ["glob1", "glob2"], "exclude": ["glob3"] }
 *   a single JSON array of globs (interpreted as include, no exclude)
 */
export function parsePatternsContent(content: string): ChunkedPatterns {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('patterns file is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `patterns file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Array.isArray(parsed)) {
    const include = parsed.filter((x): x is string => typeof x === 'string');
    if (include.length === 0) {
      throw new Error('patterns array must contain at least one glob string');
    }
    return { include };
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      'patterns file must be a JSON object { include: [...], exclude?: [...] } or an array of globs',
    );
  }
  const obj = parsed as Record<string, unknown>;
  const include = Array.isArray(obj.include)
    ? obj.include.filter((x): x is string => typeof x === 'string')
    : [];
  if (include.length === 0) {
    throw new Error('patterns.include must be a non-empty array of glob strings');
  }
  const exclude = Array.isArray(obj.exclude)
    ? obj.exclude.filter((x): x is string => typeof x === 'string')
    : undefined;
  return exclude && exclude.length > 0 ? { include, exclude } : { include };
}
