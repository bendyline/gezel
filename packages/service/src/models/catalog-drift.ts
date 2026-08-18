/**
 * "Is a newer build of this model available?" — asked of the payload, not of
 * the version string.
 *
 * Both engine managers (llama.cpp/ds4 and MLX) and the chat manager's
 * per-session staleness notice used to answer this by comparing the installed
 * `catalogVersion` to the catalog's current one. That flags every catalog
 * edit, including the metadata-only ones the runtime has already picked up,
 * and the only remedy any surface offers is a multi-gigabyte re-download. Here
 * the version difference is the *trigger* for a check, and
 * {@link comparePayloadIdentity} is the answer.
 *
 * When the payload turns out to be unchanged we record that finding in the
 * install manifest (a `payloadFingerprint`) so later checks are a string
 * compare. `catalogVersion` is deliberately left alone: it means "the version
 * whose description these bytes were downloaded against", which is what the
 * `.gezmodel` exporter pins and what model-fitness records compare, and
 * rewriting it would silently invalidate both.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ChatModelManifest, type GezmodelEngine, createLogger } from '@bendyline/gezel';
import {
  type InstalledPayloadRecord,
  type PayloadIdentityResult,
  catalogPayloadFingerprint,
  comparePayloadIdentity,
  describeCatalogPayload,
} from './catalog-payload-identity.js';
import { makeSharedModelReadable } from './storage-roots.js';

const log = createLogger('models');

export interface ModelUpdateStatus {
  /** True only when the catalog's payload differs from the copy on disk. */
  updateAvailable: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
  /** Why, in one sentence — surfaced in the model manager's tooltip. */
  reason?: string;
}

export interface EvaluateCatalogDriftOptions {
  engine: GezmodelEngine;
  id: string;
  /** Absolute model directory, for the size fallback and the fingerprint write. */
  modelDir: string;
  /** Version recorded at install. No version → nothing to compare. */
  installedVersion?: string;
  installed: InstalledPayloadRecord;
  manifest: ChatModelManifest;
  /**
   * False for models resolved out of a read-only overlay (the machine asset
   * store) and while an install is in flight for this id — the verdict still
   * stands, we just don't write it down.
   */
  healable: boolean;
}

/** In-process dedupe: model inventory is polled, and one heal per copy is enough. */
const healed = new Set<string>();

export async function evaluateCatalogDrift(
  opts: EvaluateCatalogDriftOptions,
): Promise<ModelUpdateStatus> {
  const currentVersion = opts.manifest.version;
  if (!opts.installedVersion || !currentVersion || opts.installedVersion === currentVersion) {
    return { updateAvailable: false };
  }

  const catalog = describeCatalogPayload(opts.manifest, opts.engine);
  if (!catalog) {
    // The catalog no longer describes this engine's payload at all (a source
    // block was pulled). Nothing to download, so nothing to offer.
    return { updateAvailable: false };
  }

  const result = await comparePayloadIdentity({
    catalog,
    installed: opts.installed,
    modelDir: opts.modelDir,
  });

  if (result.identity === 'same') {
    if (opts.healable && result.provenByHash && !opts.installed.payloadFingerprint) {
      await recordPayloadFingerprint(opts, catalogPayloadFingerprint(catalog), result);
    }
    return { updateAvailable: false };
  }
  if (result.identity === 'unknown') {
    // Can't prove either way, so fall back to what the version string says.
    // Being wrong here costs the user a badge, not their bandwidth — the
    // update action stays theirs to take.
    return {
      updateAvailable: true,
      availableVersion: currentVersion,
      reason: `The catalog has moved to v${currentVersion} and Gezel could not confirm whether this copy's files changed (${result.reason}).`,
    };
  }
  return {
    updateAvailable: true,
    availableVersion: currentVersion,
    reason: `${result.reason}. Updating downloads only the files that differ.`,
  };
}

async function recordPayloadFingerprint(
  opts: EvaluateCatalogDriftOptions,
  fingerprint: string,
  result: PayloadIdentityResult,
): Promise<void> {
  const manifestPath = join(opts.modelDir, 'manifest.json');
  if (healed.has(manifestPath)) return;
  healed.add(manifestPath);
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    if (parsed.payloadFingerprint === fingerprint) return;
    const tmpPath = `${manifestPath}.heal.tmp`;
    await writeFile(
      tmpPath,
      `${JSON.stringify({ ...parsed, payloadFingerprint: fingerprint }, null, 2)}\n`,
      { encoding: 'utf8' },
    );
    await rename(tmpPath, manifestPath);
    // A machine service writes into the shared asset store under a private
    // umask; without this the healed manifest becomes unreadable to the very
    // desktop clients that list the model.
    await makeSharedModelReadable(opts.modelDir);
    log.info(
      `[${opts.engine}] "${opts.id}" is current with catalog v${opts.manifest.version} despite installing at v${opts.installedVersion} — ${result.reason}; recorded payload fingerprint`,
    );
  } catch (err) {
    // A heal we couldn't write is a heal we redo next boot. Never let it
    // break a listing.
    healed.delete(manifestPath);
    log.debug(
      `[${opts.engine}] could not record payload fingerprint for "${opts.id}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Test seam — the dedupe set is process-global. */
export function resetPayloadFingerprintHealsForTest(): void {
  healed.clear();
}
