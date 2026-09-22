import { readFile, readdir, stat } from 'node:fs/promises';
import { type ScriptMeta, type ScriptRun, createLogger } from '@bendyline/gezel';
import {
  projectScriptFile,
  projectScriptRunFile,
  projectScriptRunsDir,
  projectScriptsDir,
} from '@bendyline/gezel/paths';
import { readScriptMeta } from './meta.js';

const log = createLogger('catalog');

/**
 * Enumerate every script under a project's `scripts/` directory whose
 * `meta` block parses. Scripts with a malformed `meta` are skipped
 * with a logged warning — one bad file shouldn't hide the rest.
 */
export async function listProjectScripts(
  home: string,
  projectId: string,
): Promise<Array<{ name: string; meta: ScriptMeta; path: string }>> {
  const dir = projectScriptsDir(home, projectId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; meta: ScriptMeta; path: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const name = entry.slice(0, -3);
    const path = projectScriptFile(home, projectId, name);
    try {
      const meta = await readScriptMeta(path);
      out.push({ name, meta, path });
    } catch (err) {
      log.warn(`[scripts] skipping ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export { readProjectScriptRun } from './runs.js';
