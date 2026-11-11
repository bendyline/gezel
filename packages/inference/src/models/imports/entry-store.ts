/**
 * Where an imported model's catalog entry lives: `.gezel-catalog-entry.json`
 * in the model's own folder under the llama.cpp or MLX model store. Beside the
 * weights, so it is created, moved, shared and deleted with them and never
 * outlives them; a dot-file, so payload hashing, pruning and bundle export
 * skip it.
 *
 * Read back through the catalog's imported-models source, which every
 * `catalog.get('chat-model', id)` falls through to last.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatModelManifest,
  IMPORTED_CHAT_MODEL_ENTRY_FILE,
  IMPORTED_CHAT_MODEL_ID_PREFIX,
  type ImportedChatModelEntry,
  LOCAL_FILE_CHAT_MODEL_ID_PREFIX,
  buildImportedChatModelEntry,
  parseImportedChatModelEntry,
} from '@bendyline/gezel';
import { assertModelStorePathSafe, modelStorageRoots } from '../storage-roots.js';

/** The catalog-side contract (`@bendyline/gezel-catalog` ImportedChatModelReader). */
export interface ImportedChatModelEntryReader {
  get(id: string): Promise<ImportedChatModelEntry | null>;
  list(): Promise<ImportedChatModelEntry[]>;
}

const LIST_CACHE_MS = 2_000;
const ENGINES = ['llama-cpp', 'mlx'] as const;

export function isImportedModelId(id: string): boolean {
  return (
    (id.startsWith(IMPORTED_CHAT_MODEL_ID_PREFIX) ||
      id.startsWith(LOCAL_FILE_CHAT_MODEL_ID_PREFIX)) &&
    /^[a-z0-9][a-z0-9.\-:]{1,63}$/.test(id)
  );
}

function serialize(manifest: ChatModelManifest, tuningFrom?: string): string {
  const entry = parseImportedChatModelEntry(buildImportedChatModelEntry(manifest, tuningFrom));
  if (!entry) throw new Error('the imported model entry did not survive validation');
  return `${JSON.stringify(entry, null, 2)}\n`;
}

async function writeAtomically(dir: string, text: string): Promise<void> {
  const target = join(dir, IMPORTED_CHAT_MODEL_ENTRY_FILE);
  const temp = join(dir, `.${randomUUID()}.entry.tmp`);
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Write (or replace) an entry beside where the installer will put the weights. */
export async function writeImportedModelEntry(
  modelsRoot: string,
  manifest: ChatModelManifest,
  tuningFrom?: string,
): Promise<void> {
  if (!isImportedModelId(manifest.id)) throw new Error(`not an imported model id: ${manifest.id}`);
  const text = serialize(manifest, tuningFrom);
  const dir = join(modelsRoot, manifest.id);
  await mkdir(modelsRoot, { recursive: true });
  await assertModelStorePathSafe(modelsRoot, dir);
  await mkdir(dir, { recursive: true });
  await assertModelStorePathSafe(modelsRoot, dir);
  await writeAtomically(dir, text);
}

/** Write an entry into a staged model folder before it is published. */
export async function writeImportedModelEntryInto(
  stagedDir: string,
  manifest: ChatModelManifest,
  tuningFrom?: string,
): Promise<void> {
  await writeAtomically(stagedDir, serialize(manifest, tuningFrom));
}

async function readEntry(dir: string, id: string): Promise<ImportedChatModelEntry | null> {
  const raw = await readFile(join(dir, IMPORTED_CHAT_MODEL_ENTRY_FILE), 'utf8').catch(() => null);
  if (raw === null || raw.length > 256 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = parseImportedChatModelEntry(parsed);
  return entry && entry.manifest.id === id ? entry : null;
}

/**
 * Entries across this home's llama.cpp and MLX model roots: each engine's own
 * store first, then the read-only ones (the machine store, other app homes),
 * the same order the model managers resolve weights in.
 */
export function createImportedChatModelReader(opts: {
  home: string;
  env?: NodeJS.ProcessEnv;
}): ImportedChatModelEntryReader {
  const roots = () =>
    ENGINES.flatMap((engine) => {
      const resolved = modelStorageRoots({
        home: opts.home,
        engine,
        ...(opts.env ? { env: opts.env } : {}),
      });
      return [resolved.writableRoot, ...resolved.readOnlyRoots];
    });
  let cached: { at: number; list: Promise<ImportedChatModelEntry[]> } | null = null;

  const get = async (id: string): Promise<ImportedChatModelEntry | null> => {
    if (!isImportedModelId(id)) return null;
    for (const root of roots()) {
      const entry = await readEntry(join(root, id), id);
      if (entry) return entry;
    }
    return null;
  };

  const scan = async (): Promise<ImportedChatModelEntry[]> => {
    const seen = new Set<string>();
    const out: ImportedChatModelEntry[] = [];
    for (const root of roots()) {
      const ids = await readdir(root).catch(() => [] as string[]);
      for (const id of ids) {
        if (seen.has(id) || !isImportedModelId(id)) continue;
        const entry = await readEntry(join(root, id), id);
        if (!entry) continue;
        seen.add(id);
        out.push(entry);
      }
    }
    return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  };

  return {
    get,
    list: () => {
      const now = Date.now();
      if (!cached || now - cached.at > LIST_CACHE_MS) {
        cached = { at: now, list: scan().catch(() => []) };
      }
      return cached.list;
    },
  };
}
