import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SCRIPTS_DIR = join('.claude', 'ewh-scripts');

export function scriptCachePath(projectRoot: string, workflow: string, stepName: string): string {
  return resolve(projectRoot, SCRIPTS_DIR, workflow, `${stepName}.sh`);
}

export function hashCachePath(projectRoot: string, workflow: string, stepName: string): string {
  return resolve(projectRoot, SCRIPTS_DIR, workflow, `${stepName}.hash`);
}

export type CachedScript = {
  path: string;
  storedHash: string | null;
};

export async function readCachedScript(
  projectRoot: string,
  workflow: string,
  stepName: string,
): Promise<CachedScript | null> {
  const path = scriptCachePath(projectRoot, workflow, stepName);
  try {
    await fs.access(path);
  } catch {
    return null;
  }
  let storedHash: string | null = null;
  try {
    storedHash = (await fs.readFile(hashCachePath(projectRoot, workflow, stepName), 'utf8')).trim();
  } catch {
    // no hash file — treat as un-hashed
  }
  return { path, storedHash };
}

export async function writeCachedScript(
  projectRoot: string,
  workflow: string,
  stepName: string,
  script: string,
  hash: string,
): Promise<void> {
  const path = scriptCachePath(projectRoot, workflow, stepName);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, script, { mode: 0o755 });
  await fs.writeFile(hashCachePath(projectRoot, workflow, stepName), hash + '\n', 'utf8');
}

export async function deleteCachedScript(
  projectRoot: string,
  workflow: string,
  stepName: string,
): Promise<void> {
  await fs.rm(scriptCachePath(projectRoot, workflow, stepName), { force: true });
  await fs.rm(hashCachePath(projectRoot, workflow, stepName), { force: true });
}

export type CachedScriptEntry = { stepName: string; path: string };

export async function listCachedScripts(
  projectRoot: string,
  workflow: string,
): Promise<CachedScriptEntry[]> {
  const dir = resolve(projectRoot, SCRIPTS_DIR, workflow);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith('.sh'))
      .map((e) => ({ stepName: e.slice(0, -3), path: join(dir, e) }));
  } catch {
    return [];
  }
}
