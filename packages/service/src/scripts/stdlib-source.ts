import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GetScriptSourceResponse, type ScriptMeta, createLogger } from '@bendyline/gezel';
import { parseScriptMeta } from './meta.js';
import { scriptSourceHash } from './source.js';

const log = createLogger('scripts');

const STDLIB_PACKAGE_NAME = '@bendyline/gezel-script-stdlib';

/**
 * The standard gate-script library packed into the app
 * (`packages/script-stdlib/scripts/*.ts`). Resolved IN PLACE and
 * read-only by construction — no write/delete functions exist in this
 * module. Standard scripts are trusted: the runner lets them execute
 * even when the security policy disables user script execution, which
 * is exactly why nothing outside the app bundle may ever masquerade as
 * one (resolution only ever reads from this package's directory).
 */

let cachedDir: string | null = null;

export async function resolveStdlibDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  // Walk up from this module checking the monorepo/bundled layouts —
  // same strategy as resolveSdkDir (see sdk.ts for why fixed-depth
  // candidates break under the single-file dist bundle).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    for (const candidate of [join(dir, 'script-stdlib'), join(dir, 'packages', 'script-stdlib')]) {
      if (await isStdlibDir(candidate)) {
        cachedDir = candidate;
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let entryDir: string;
  try {
    entryDir = dirname(fileURLToPath(import.meta.resolve(`${STDLIB_PACKAGE_NAME}/package.json`)));
  } catch {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    entryDir = dirname(require.resolve(`${STDLIB_PACKAGE_NAME}/package.json`));
  }
  if (await isStdlibDir(entryDir)) {
    cachedDir = entryDir;
    return entryDir;
  }
  throw new Error(`could not locate the ${STDLIB_PACKAGE_NAME} package on disk`);
}

async function isStdlibDir(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return pkg.name === STDLIB_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Library version (the package version — the stdlib ships with the app). */
export async function stdlibVersion(): Promise<string> {
  const dir = await resolveStdlibDir();
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

export async function stdlibScriptFile(name: string): Promise<string> {
  if (!/^[a-zA-Z][\w-]*$/.test(name)) {
    throw new Error(`invalid standard script name "${name}"`);
  }
  const dir = await resolveStdlibDir();
  return join(dir, 'scripts', `${name}.ts`);
}

export async function listStdlibScripts(): Promise<
  Array<{ name: string; meta: ScriptMeta; path: string }>
> {
  const dir = join(await resolveStdlibDir(), 'scripts');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; meta: ScriptMeta; path: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const name = entry.slice(0, -3);
    const path = join(dir, entry);
    try {
      const meta = parseScriptMeta(await readFile(path, 'utf8'), path);
      out.push({ name, meta, path });
    } catch (err) {
      log.warn(`[stdlib] skipping ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readStdlibScriptSource(
  name: string,
): Promise<GetScriptSourceResponse | null> {
  let source: string;
  try {
    source = await readFile(await stdlibScriptFile(name), 'utf8');
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = {
    name,
    source,
    hash: scriptSourceHash(source),
    mtimeMs: 0,
    provenance: { kind: 'standard', ref: `stdlib@${await stdlibVersion()}` },
  };
  try {
    out.meta = parseScriptMeta(source, `${name}.ts`);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  return out;
}
