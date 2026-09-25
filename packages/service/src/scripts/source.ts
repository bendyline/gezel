import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type GetScriptSourceResponse,
  ScriptNameSchema,
  type ScriptProvenance,
} from '@bendyline/gezel';
import { projectScriptFile, userScriptFile, userScriptsDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { craftbookScriptProvenance, generatedScriptProvenance } from './install.js';
import { parseScriptMeta } from './meta.js';

/**
 * Raw script source access for the in-app editor. Deliberately separate
 * from `catalog.ts`: the list endpoint hides scripts whose meta fails to
 * parse, but the editor must be able to open a broken script to fix it,
 * so everything here works on the file bytes first and treats meta as
 * best-effort decoration.
 */

export function scriptSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * The single fence between user-supplied names and the filesystem: every
 * exported function validates through this before building a path.
 */
function checkedScriptFile(home: string, projectId: string, name: string): string {
  ScriptNameSchema.parse(name);
  return projectScriptFile(home, projectId, name);
}

function parseProvenance(source: string): ScriptProvenance | undefined {
  const craftbook = craftbookScriptProvenance(source);
  if (craftbook) return { kind: 'craftbook', ref: craftbook };
  const imported = generatedScriptProvenance(source);
  if (imported) return { kind: 'import', ref: imported };
  return undefined;
}

export async function readScriptSource(
  home: string,
  projectId: string,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  const file = checkedScriptFile(home, projectId, name);
  let source: string;
  let mtimeMs: number;
  try {
    source = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = {
    name,
    source,
    hash: scriptSourceHash(source),
    mtimeMs,
  };
  try {
    out.meta = parseScriptMeta(source, file);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  const provenance = parseProvenance(source);
  if (provenance) out.provenance = provenance;
  return out;
}

export async function writeScriptSource(
  home: string,
  projectId: string,
  name: string,
  source: string,
): Promise<{ hash: string }> {
  const file = checkedScriptFile(home, projectId, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, source);
  return { hash: scriptSourceHash(source) };
}

export async function scriptSourceExists(
  home: string,
  projectId: string,
  name: string,
): Promise<boolean> {
  const file = checkedScriptFile(home, projectId, name);
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function deleteScriptSource(
  home: string,
  projectId: string,
  name: string,
): Promise<boolean> {
  const file = checkedScriptFile(home, projectId, name);
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────── User-scope library (~/.gezel/scripts) ────────────── */

function checkedUserScriptFile(home: string, name: string): string {
  ScriptNameSchema.parse(name);
  return userScriptFile(home, name);
}

export async function listUserScripts(
  home: string,
): Promise<Array<{ name: string; meta: import('@bendyline/gezel').ScriptMeta; path: string }>> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(userScriptsDir(home));
  } catch {
    return [];
  }
  const out: Array<{ name: string; meta: import('@bendyline/gezel').ScriptMeta; path: string }> =
    [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const name = entry.slice(0, -3);
    const path = userScriptFile(home, name);
    try {
      out.push({ name, meta: parseScriptMeta(await readFile(path, 'utf8'), path), path });
    } catch {
      /* unparseable meta — hidden from the list, still readable below */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readUserScriptSource(
  home: string,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  const file = checkedUserScriptFile(home, name);
  let source: string;
  let mtimeMs: number;
  try {
    source = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = {
    name,
    source,
    hash: scriptSourceHash(source),
    mtimeMs,
    provenance: { kind: 'user', ref: name },
  };
  try {
    out.meta = parseScriptMeta(source, file);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

export async function writeUserScriptSource(
  home: string,
  name: string,
  source: string,
): Promise<{ hash: string }> {
  const file = checkedUserScriptFile(home, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, source);
  return { hash: scriptSourceHash(source) };
}

export async function deleteUserScriptSource(home: string, name: string): Promise<boolean> {
  const file = checkedUserScriptFile(home, name);
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

export {
  computeScriptDiagnostics,
  validateCraftbookScripts,
  craftbookScriptErrors,
  scaffoldScript,
} from '@bendyline/gezel-script-runtime/source';
