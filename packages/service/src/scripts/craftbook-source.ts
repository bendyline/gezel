import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type GetScriptSourceResponse, ScriptNameSchema } from '@bendyline/gezel';
import {
  craftbookShardPrefix,
  craftbookTemplateDir,
  craftbookTemplateScriptFile,
  craftbookTemplateScriptsDir,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { parseScriptMeta } from './meta.js';
import { scriptSourceHash } from './source.js';

/**
 * Raw source access for scripts BUNDLED inside a local craftbook template
 * (mirroring the catalog's `versions/<ver>/scripts/*.ts` layout). The
 * craftbook-scoped sibling of `source.ts` — same response shape so the
 * Monaco editor and diagnostics work unchanged, only the file location
 * differs. v1 targets the latest version dir (local books have one).
 */

async function latestVersion(home: string, id: string): Promise<string> {
  const prefix = craftbookShardPrefix(id);
  const versionsDir = join(craftbookTemplateDir(home, prefix, id), 'versions');
  try {
    const vs = (await readdir(versionsDir)).filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (vs.length) return vs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
  } catch {
    /* none yet */
  }
  return '1.0.0';
}

export async function listCraftbookScripts(home: string, id: string): Promise<{ name: string }[]> {
  const prefix = craftbookShardPrefix(id);
  const version = await latestVersion(home, id);
  const dir = craftbookTemplateScriptsDir(home, prefix, id, version);
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.ts')).map((f) => ({ name: f.replace(/\.ts$/, '') }));
  } catch {
    return [];
  }
}

export async function readCraftbookScriptSource(
  home: string,
  id: string,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  ScriptNameSchema.parse(name);
  const prefix = craftbookShardPrefix(id);
  const version = await latestVersion(home, id);
  const file = craftbookTemplateScriptFile(home, prefix, id, version, name);
  let source: string;
  let mtimeMs: number;
  try {
    source = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = { name, source, hash: scriptSourceHash(source), mtimeMs };
  try {
    out.meta = parseScriptMeta(source, file);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

export async function writeCraftbookScriptSource(
  home: string,
  id: string,
  name: string,
  source: string,
): Promise<{ hash: string }> {
  ScriptNameSchema.parse(name);
  const prefix = craftbookShardPrefix(id);
  const version = await latestVersion(home, id);
  const dir = craftbookTemplateScriptsDir(home, prefix, id, version);
  await mkdir(dir, { recursive: true });
  const file = craftbookTemplateScriptFile(home, prefix, id, version, name);
  await writeFileAtomic(file, source);
  return { hash: scriptSourceHash(source) };
}

export async function deleteCraftbookScriptSource(
  home: string,
  id: string,
  name: string,
): Promise<boolean> {
  ScriptNameSchema.parse(name);
  const prefix = craftbookShardPrefix(id);
  const version = await latestVersion(home, id);
  const file = craftbookTemplateScriptFile(home, prefix, id, version, name);
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}
