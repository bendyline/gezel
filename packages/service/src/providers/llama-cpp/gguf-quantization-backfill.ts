/**
 * "What quantization is this, really?" — asked of the model file when the
 * catalog's answer isn't one.
 *
 * A catalog `quantization` string is hand-authored content, and
 * `muse-glimmer-30b-q4` shipped `K-Quant-17GB` — the upstream GGUF filename,
 * which names no bit depth and rendered verbatim in a column of `~4` / `~8`.
 * Installs from here on record the file's own `general.file_type` tag
 * alongside the catalog's, but every copy already on disk predates the field,
 * so this reads the header once and writes the answer down.
 *
 * Deliberately narrow: it runs only when the catalog tag carries no bit depth
 * at all. A GGUF header read is cheap next to the weights but not free, and a
 * model whose catalog label already says `Q4_K_M` has nothing to learn from
 * asking the file.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GezmodelEngine, createLogger, quantizationBitDepths } from '@bendyline/gezel';
import { makeSharedModelReadable } from '../../models/storage-roots.js';
import { ggufQuantizationTag, readGgufSummary } from './gguf-metadata.js';

const log = createLogger('models');

/**
 * In-process memo of what the header said, keyed by manifest path. Model
 * inventory is polled, and a read-only overlay copy can never persist its
 * answer — without this, every poll would re-read the header of every such
 * model forever. `null` records "asked, and the file has no usable tag".
 */
const resolved = new Map<string, string | null>();

export interface BackfillGgufQuantizationOptions {
  engine: GezmodelEngine;
  id: string;
  /** Absolute model directory — holds both the weights and `manifest.json`. */
  modelDir: string;
  /** Weights filename from the install manifest (first shard when sharded). */
  weightsFilename: string;
  /** The catalog-authored tag, whatever it says. */
  catalogQuantization?: string;
  /** False for read-only overlay copies: the verdict still stands, we just can't write it down. */
  writable: boolean;
}

export async function backfillGgufQuantization(
  opts: BackfillGgufQuantizationOptions,
): Promise<string | undefined> {
  if (quantizationBitDepths(opts.catalogQuantization).length > 0) return undefined;

  const manifestPath = join(opts.modelDir, 'manifest.json');
  const memo = resolved.get(manifestPath);
  if (memo !== undefined) return memo ?? undefined;

  let tag: string | undefined;
  try {
    tag = ggufQuantizationTag(readGgufSummary(join(opts.modelDir, opts.weightsFilename)));
  } catch (err) {
    // The listing is not the place to fail over unreadable metadata — the
    // payload verification above it already gates whether this model runs.
    log.debug(
      `[${opts.engine}] could not read the GGUF quantization of "${opts.id}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    resolved.set(manifestPath, null);
    return undefined;
  }
  resolved.set(manifestPath, tag ?? null);
  if (!tag || !opts.writable) return tag;

  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    if (parsed.ggufQuantization === tag) return tag;
    const tmpPath = `${manifestPath}.quant.tmp`;
    await writeFile(tmpPath, `${JSON.stringify({ ...parsed, ggufQuantization: tag }, null, 2)}\n`, {
      encoding: 'utf8',
    });
    await rename(tmpPath, manifestPath);
    // A machine service writes into the shared asset store under a private
    // umask; without this the healed manifest becomes unreadable to the very
    // desktop clients that list the model.
    await makeSharedModelReadable(opts.modelDir);
    log.info(
      `[${opts.engine}] "${opts.id}" declares ${tag}; recorded it beside the catalog's "${opts.catalogQuantization ?? '(none)'}"`,
    );
  } catch (err) {
    // A heal we couldn't write is a heal we redo next boot.
    log.debug(
      `[${opts.engine}] could not record the GGUF quantization of "${opts.id}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return tag;
}

/** Test seam — the memo is process-wide by design. */
export function resetGgufQuantizationMemo(): void {
  resolved.clear();
}
