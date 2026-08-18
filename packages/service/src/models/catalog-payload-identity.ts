/**
 * Does the catalog still describe the bytes this model was installed from?
 *
 * A catalog version bump means one of two very different things. Either the
 * payload moved — new repo, new quant, rotated shas, an added shard — and the
 * user really is running an older build; or only metadata changed (tuning,
 * sizing hints, release date, wording), which the runtime already resolves
 * live from the catalog on every turn and which nothing on disk has to catch
 * up with. Comparing version strings cannot tell those apart, so a metadata
 * edit asked every installed model to re-download itself: five models, ~100 GB
 * of transfer, to adopt a `residentBytes` removal that had already taken
 * effect. This module asks the question the version string was standing in
 * for.
 *
 * Three tiers, most conclusive first:
 *
 *   1. `payloadFingerprint` — a hash of the catalog's own payload description,
 *      snapshotted into the install manifest at download time. Recomputing it
 *      from the current catalog is an exact answer for free.
 *   2. `fileSha256` — the per-file digests every install records. Compare them
 *      to the catalog's pins file by file.
 *   3. On-disk sizes vs the catalog's `sizeBytes`. All that installs predating
 *      the hash map can offer; strong evidence across a multi-shard payload,
 *      but evidence, not proof — so it never upgrades an install to tier 1.
 *
 * A sibling check lives in `shared-model-migration.ts`
 * (`assertCatalogPayloadIntegrity`). It answers a different question — may
 * these bytes be admitted to the machine-wide store — and stays a hard
 * assertion over a freshly-hashed bundle. This one is a read-only comparison
 * over what the install already recorded, and its answers steer UI, never
 * trust.
 */

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChatModelManifest, GezmodelEngine } from '@bendyline/gezel';

/** One file the catalog expects to land in the model directory. */
export interface CatalogPayloadFile {
  /** Name as it lands on disk ('/'-joined for nested files, as in `fileSha256`). */
  name: string;
  sha256: string;
  sizeBytes?: number;
  /**
   * Absent-on-disk is legitimate for this file. llama.cpp's vision projector
   * is only fetched when the user opts into it, so a text-only install of a
   * multimodal model is complete without it.
   */
  optional?: boolean;
  /**
   * Install rewrites this file after verifying it, so its recorded hash is
   * ours rather than the catalog's. Only presence can be asserted. Today
   * that is `tokenizer_config.json` on MLX entries that carry a chat-template
   * fallback.
   */
  transformed?: boolean;
}

/** The catalog's description of one engine's payload for one model. */
export interface CatalogPayload {
  huggingfaceRepo: string;
  files: CatalogPayloadFile[];
  /**
   * Catalog-pinned chat template. Part of the payload's identity because
   * installing it mutates a file on disk — a change here is a change to what
   * a fresh install would produce.
   */
  chatTemplate?: string;
}

export type PayloadIdentity = 'same' | 'changed' | 'unknown';

/** Which tier answered — recorded in logs so a surprising verdict is traceable. */
export type PayloadIdentityBasis = 'fingerprint' | 'hashes' | 'sizes' | 'repo' | 'none';

export interface PayloadIdentityResult {
  identity: PayloadIdentity;
  basis: PayloadIdentityBasis;
  /** One sentence, safe to log and to show in a tooltip. */
  reason: string;
  /**
   * True when the verdict is `same` and was proven by hash — the caller may
   * record the fingerprint so later checks land on tier 1. A size-only match
   * never sets this.
   */
  provenByHash?: boolean;
}

/** The fields an install manifest contributes to the comparison. */
export interface InstalledPayloadRecord {
  huggingfaceRepo?: string;
  payloadFingerprint?: string;
  /** sha256 by '/'-joined relative path, recorded at install time. */
  fileSha256?: Record<string, string>;
}

export interface ComparePayloadOptions {
  catalog: CatalogPayload;
  installed: InstalledPayloadRecord;
  /** Model directory on disk. Without it the size fallback cannot run. */
  modelDir?: string;
  /** Test seam; returns null when the file is absent. */
  statSize?: (absolutePath: string) => Promise<number | null>;
}

/**
 * Stable hash of a catalog payload description. Deliberately excludes
 * `revision`: it is a fetch coordinate, and identical hashes mean identical
 * bytes no matter which commit served them.
 */
export function catalogPayloadFingerprint(payload: CatalogPayload): string {
  const canonical = JSON.stringify({
    repo: payload.huggingfaceRepo,
    files: payload.files
      .map((file) => [file.name, file.sha256.toLowerCase()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    ...(payload.chatTemplate ? { chatTemplate: payload.chatTemplate } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Translate a catalog manifest into the payload one engine would install.
 * The single place that knows each source block's shape, so callers compare
 * like for like without re-deriving filenames.
 */
export function describeCatalogPayload(
  manifest: ChatModelManifest,
  engine: GezmodelEngine,
): CatalogPayload | null {
  if (engine === 'mlx') {
    const src = manifest.mlx;
    if (!src) return null;
    // The install pipeline merges a template into tokenizer_config.json when
    // upstream ships none, in which case the file on disk is no longer the
    // file the catalog hashed. A sidecar in the file list means the same
    // recovery path is reachable.
    const templateMayBeInjected = Boolean(
      src.chatTemplate || src.files.some((file) => basename(file.name) === 'chat_template.jinja'),
    );
    return {
      huggingfaceRepo: src.huggingfaceRepo,
      ...(src.chatTemplate ? { chatTemplate: src.chatTemplate } : {}),
      files: src.files.map((file) => ({
        name: file.name,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        ...(templateMayBeInjected && basename(file.name) === 'tokenizer_config.json'
          ? { transformed: true }
          : {}),
      })),
    };
  }

  const src = engine === 'ds4' ? manifest.ds4 : manifest.llamaCpp;
  if (!src) return null;
  const files: CatalogPayloadFile[] = [];
  if (src.shards && src.shards.length > 0) {
    for (const shard of src.shards) {
      files.push({
        name: basename(shard.name),
        sha256: shard.sha256,
        sizeBytes: shard.sizeBytes,
      });
    }
  } else if (src.filename && src.sha256) {
    files.push({
      name: basename(src.filename),
      sha256: src.sha256,
      sizeBytes: src.approxSizeBytes,
    });
  }
  const llamaCpp = engine === 'llama-cpp' ? manifest.llamaCpp : undefined;
  if (llamaCpp?.draftModel) {
    files.push({
      name: basename(llamaCpp.draftModel.filename),
      sha256: llamaCpp.draftModel.sha256,
      sizeBytes: llamaCpp.draftModel.sizeBytes,
    });
  }
  if (llamaCpp?.mmproj) {
    // Only fetched when the user opts into vision — its absence says nothing
    // about whether the weights are current.
    files.push({
      name: basename(llamaCpp.mmproj.filename),
      sha256: llamaCpp.mmproj.sha256,
      sizeBytes: llamaCpp.mmproj.sizeBytes,
      optional: true,
    });
  }
  return files.length > 0 ? { huggingfaceRepo: src.huggingfaceRepo, files } : null;
}

export async function comparePayloadIdentity(
  opts: ComparePayloadOptions,
): Promise<PayloadIdentityResult> {
  const { catalog, installed } = opts;
  if (catalog.files.length === 0) {
    return {
      identity: 'unknown',
      basis: 'none',
      reason: 'the catalog entry describes no payload files',
    };
  }

  if (installed.payloadFingerprint) {
    if (installed.payloadFingerprint === catalogPayloadFingerprint(catalog)) {
      return {
        identity: 'same',
        basis: 'fingerprint',
        reason: 'the catalog describes the same files this copy was installed from',
        provenByHash: true,
      };
    }
    // The verdict is settled — the fingerprint covers things the per-file scan
    // deliberately tolerates (a rotated optional sidecar, a re-pinned chat
    // template). Walk the files anyway, purely to name one in the message: "the
    // catalog rebuilt X" is worth far more to the reader than "something moved".
    return {
      identity: 'changed',
      basis: 'fingerprint',
      reason:
        firstDifferingFile(catalog, installed.fileSha256) ??
        'the catalog now describes different model files than this copy holds',
    };
  }

  if (installed.huggingfaceRepo && installed.huggingfaceRepo !== catalog.huggingfaceRepo) {
    return {
      identity: 'changed',
      basis: 'repo',
      reason: `the catalog now sources this model from ${catalog.huggingfaceRepo} (this copy came from ${installed.huggingfaceRepo})`,
    };
  }

  const recorded = installed.fileSha256;
  if (recorded && Object.keys(recorded).length > 0) {
    const difference = firstDifferingFile(catalog, recorded);
    return difference
      ? { identity: 'changed', basis: 'hashes', reason: difference }
      : {
          identity: 'same',
          basis: 'hashes',
          reason: 'every file the catalog pins matches the copy on disk',
          provenByHash: true,
        };
  }

  const modelDir = opts.modelDir;
  if (!modelDir) {
    return {
      identity: 'unknown',
      basis: 'none',
      reason: 'this copy recorded no file hashes and its directory was not supplied',
    };
  }
  const statSize = opts.statSize ?? defaultStatSize;
  let compared = 0;
  for (const file of catalog.files) {
    if (file.sizeBytes === undefined) continue;
    const size = await statSize(join(modelDir, ...file.name.split('/')));
    if (size === null) {
      if (file.optional) continue;
      return {
        identity: 'changed',
        basis: 'sizes',
        reason: `the catalog now ships ${file.name}, which this copy does not have`,
      };
    }
    if (size !== file.sizeBytes) {
      return {
        identity: 'changed',
        basis: 'sizes',
        reason: `${file.name} is a different size than the file the catalog now pins`,
      };
    }
    compared += 1;
  }
  if (compared === 0) {
    return {
      identity: 'unknown',
      basis: 'none',
      reason: 'this copy recorded no file hashes and the catalog pins no file sizes',
    };
  }
  return {
    identity: 'same',
    basis: 'sizes',
    reason: `all ${compared} file(s) the catalog pins are present at the expected size`,
  };
}

/**
 * The first catalog file the recorded digests don't account for, phrased for a
 * reader, or null when they all check out. A file the install knowingly
 * rewrote can only be checked for presence, and an optional one may be absent
 * outright.
 */
function firstDifferingFile(
  catalog: CatalogPayload,
  recorded: Record<string, string> | undefined,
): string | null {
  if (!recorded || Object.keys(recorded).length === 0) return null;
  for (const file of catalog.files) {
    const actual = recorded[file.name];
    if (actual === undefined) {
      if (file.optional) continue;
      return `the catalog now ships ${file.name}, which this copy does not have`;
    }
    if (file.transformed) continue;
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      return `${file.name} differs from the file the catalog now pins`;
    }
  }
  return null;
}

async function defaultStatSize(absolutePath: string): Promise<number | null> {
  return stat(absolutePath)
    .then((info) => (info.isFile() ? info.size : null))
    .catch(() => null);
}
