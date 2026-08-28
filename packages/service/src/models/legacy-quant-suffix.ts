import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, quantSuffixedModelId } from '@bendyline/gezel';
import {
  type ModelStorageRoots,
  assertModelStorePathSafe,
  findModelRoot,
} from './storage-roots.js';

/**
 * One-shot rename of installs whose id predates the quant-suffix convention.
 *
 * Every current chat-model catalog id ends in the width it ships, but ids
 * minted before that (`mistral`, `qwen3.5-9b`, `gemma4-e4b`) do not — and
 * the model table shows the install id, so a Q8 E4B sat one row below its
 * own Q4 sibling with nothing on the row to tell them apart. Renaming the
 * directory is what fixes the display, because there is no separate title
 * to fix: the id IS the name the table prints.
 *
 * Two things keep this from being a breaking change. The install records
 * its former id, which {@link findRenamedModelId} resolves so pins written
 * against the old name still load. And `catalogId` is deliberately left
 * alone: it is what tuning, drift, and eval hints resolve through (via
 * `normalizeChatModelCatalogId`), and repointing it would silently move a
 * model onto another build's tuning — the exact reason `gemma4-e4b` was
 * never aliased onto `gemma4-e4b-q4` in the first place.
 */

const log = createLogger('models');

export interface QuantSuffixRename {
  engine: string;
  from: string;
  to: string;
}

interface LegacyManifest {
  id?: unknown;
  quantization?: unknown;
  ggufQuantization?: unknown;
  renamedFrom?: unknown;
}

/**
 * Rename every legacy-id install in this engine's writable root. Read-only
 * overlays (the machine asset store) are left untouched — this daemon is not
 * their writer, and a machine model shadowed by a rename here would resolve
 * to neither name.
 */
export async function migrateLegacyQuantSuffixIds(opts: {
  roots: ModelStorageRoots;
  engine: string;
}): Promise<QuantSuffixRename[]> {
  const { roots, engine } = opts;
  let entries: string[];
  try {
    entries = await readdir(roots.writableRoot);
  } catch {
    return [];
  }

  const renames: QuantSuffixRename[] = [];
  for (const id of entries) {
    // `.` entries are publish backups and staging dirs, never model ids.
    if (id.startsWith('.')) continue;
    const from = join(roots.writableRoot, id);
    const manifestPath = join(from, 'manifest.json');
    const parsed = await readFile(manifestPath, 'utf8')
      .then((raw) => JSON.parse(raw) as LegacyManifest)
      .catch(() => null);
    if (!parsed || parsed.id !== id) continue;

    // The catalog tag is hand-authored content and can name no width at all
    // (`muse-glimmer-30b-q4` shipped `K-Quant-17GB`); the GGUF header's own
    // declaration is the fallback, and when neither names a width we leave
    // the install alone rather than guess one into its name.
    const quantization =
      typeof parsed.quantization === 'string'
        ? parsed.quantization
        : typeof parsed.ggufQuantization === 'string'
          ? parsed.ggufQuantization
          : undefined;
    const to = quantSuffixedModelId(id, quantization);
    if (!to) continue;
    if (await findModelRoot(roots, to)) {
      log.warn(`[models] cannot rename ${engine} model "${id}" to "${to}": that id is installed`);
      continue;
    }

    const target = join(roots.writableRoot, to);
    try {
      await assertModelStorePathSafe(roots.writableRoot, from);
      await assertModelStorePathSafe(roots.writableRoot, target);
      await rename(from, target);
    } catch (err) {
      log.warn(`[models] could not rename ${engine} model "${id}" to "${to}": ${String(err)}`);
      continue;
    }
    try {
      const raw = await readFile(join(target, 'manifest.json'), 'utf8');
      const next = { ...(JSON.parse(raw) as LegacyManifest), id: to, renamedFrom: id };
      await writeFile(join(target, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (err) {
      // The directory now carries a name its manifest disagrees with, which
      // every listing surface skips. Put it back rather than leave it hidden.
      await rename(target, from).catch(() => undefined);
      log.warn(`[models] rolled back rename of ${engine} model "${id}": ${String(err)}`);
      continue;
    }
    log.info(`[models] renamed ${engine} model "${id}" to "${to}" (id now names its quantization)`);
    renames.push({ engine, from: id, to });
  }
  return renames;
}

/**
 * Rewrite the `<engine>:<modelId>` keys a rename would otherwise orphan.
 *
 * Unlike a model pin, these are lookups the runtime performs itself — a
 * stale key does not fail loudly, it just stops applying, so a user's
 * context override would quietly revert to the sizing policy and a proeve
 * result would read as never-measured.
 */
export function remapEngineScopedKeys<T>(
  record: Record<string, T> | undefined,
  renames: QuantSuffixRename[],
): Record<string, T> | undefined {
  if (!record || renames.length === 0) return record;
  let changed = false;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const hit = renames.find((r) => key === `${r.engine}:${r.from}`);
    const target = hit ? `${hit.engine}:${hit.to}` : undefined;
    // Tested against the source, not the output: iteration order must not
    // decide whether a record already held under the new id survives.
    if (target !== undefined && record[target] === undefined) {
      out[target] = value;
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : record;
}
