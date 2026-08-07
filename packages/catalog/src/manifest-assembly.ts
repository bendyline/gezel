/**
 * Pure manifest assembly + merge logic shared by `build-manifest.mjs` and
 * guarded by `manifest-assembly.test.ts`.
 *
 * Why this exists as its own module:
 *
 * A chat-model `manifest.json` has three classes of field, owned by three
 * different workflows:
 *
 *   1. Base metadata (name, description, tags, sizes, contextWindow, …) and
 *      the per-provider *source pointers* — authored in the editorial
 *      config under `scripts/manifest-configs/<id>.json`.
 *   2. Tuning behaviour fields (`style`, `behaviors`, `tuning`, `evalHints`)
 *      — these EVOLVE in the manifest itself: eval runs write refined
 *      sampling / reasoning budgets / behaviour flags straight into
 *      `data/chat-models/.../manifest.json` over time.
 *   3. The `revision` commit pin on each provider block — owned by
 *      `pin-revisions.ts`, which `build-manifest` knows nothing about.
 *
 * The original `build-manifest` regenerated the whole manifest from the
 * config on every run, so re-running it to refresh provider hashes
 * silently DROPPED every class-2 field the config didn't carry and every
 * class-3 pin — the "messy rebuild wiped the tuning block" regression
 * (e.g. the gemma4-26b-q4 QAT swap, and mistral-medium losing its
 * sampling defaults). An audit found ALL 24 manifests had diverged from
 * their configs this way.
 *
 * `assembleManifest` makes a rebuild non-lossy by construction: the
 * on-disk manifest is authoritative for base + editorial fields; the
 * config only seeds a brand-new manifest or fills a field the manifest
 * lacks. The freshly fetched provider file data (sha256 / size / file
 * lists) always wins — that is the one thing a rebuild legitimately
 * refreshes — but the `revision` pin is carried over from the existing
 * block so a rebuild can never unpin a model. Pass `reseed: true` to
 * deliberately let the config overwrite base + editorial fields.
 */

/** Loose manifest/config shape — we merge by key without re-validating. */
export type LooseRecord = Record<string, unknown>;

/**
 * Config-authoritative base metadata, in canonical manifest key order.
 * `build-manifest` emits these right after `schemaVersion`/`kind`/`id`.
 */
export const BASE_FIELDS = [
  'name',
  'description',
  'tags',
  'category',
  'maintainer',
  'version',
  'updatedAt',
  'license',
  'licenseClass',
  'licenseShortName',
  'licenseUrl',
  'recoScore',
  'parameterSize',
  'approxSizeBytes',
  'supportsTools',
  'contextWindow',
  'kvBytesPerTokenF16',
  'kvFixedBytesF16',
  'upstream',
] as const;

/**
 * Manifest-authoritative tuning/behaviour fields, in canonical key order.
 * These are the ones eval runs evolve in place — a rebuild must preserve
 * them, never silently drop or downgrade them to a stale config value.
 */
export const EDITORIAL_FIELDS = ['style', 'behaviors', 'tuning', 'evalHints'] as const;

/** Provider blocks, in canonical manifest key order. */
export const PROVIDER_FIELDS = ['ollama', 'llamaCpp', 'mlx', 'ds4'] as const;

export interface ProviderBlocks {
  ollama?: LooseRecord;
  llamaCpp?: LooseRecord;
  mlx?: LooseRecord;
  ds4?: LooseRecord;
}

export interface AssembleInput {
  /** Editorial config (`scripts/manifest-configs/<id>.json`). */
  cfg: LooseRecord;
  /** Freshly built provider blocks (HF fetch output) — no `revision`. */
  providerBlocks: ProviderBlocks;
  /** The manifest currently on disk, or null when creating a new one. */
  existing?: LooseRecord | null;
  /** When true, config overwrites base + editorial fields (default false). */
  reseed?: boolean;
}

export interface AssembleResult {
  manifest: LooseRecord;
  /** Fields taken from the existing manifest rather than the config. */
  preservedFromManifest: string[];
  /** Provider blocks whose `revision` pin was carried over. */
  carriedRevisions: string[];
}

/**
 * Re-emit a provider block with `"revision"` inserted immediately after
 * `huggingfaceRepo`, matching where `pin-revisions.ts` writes it so disk
 * diffs stay minimal. Falls back to appending if there is no repo key.
 */
export function carryRevision(block: LooseRecord, revision: string): LooseRecord {
  const out: LooseRecord = {};
  for (const [k, v] of Object.entries(block)) {
    out[k] = v;
    if (k === 'huggingfaceRepo') out.revision = revision;
  }
  if (!('revision' in out)) out.revision = revision;
  return out;
}

/**
 * Apply an RFC 7396-style JSON Merge Patch without mutating either input.
 * Object values merge recursively, arrays/scalars replace, and `null`
 * removes a key. Release configs use this to make a small, intentional
 * tuning change without reseeding (and potentially erasing) the model's
 * eval-evolved sampling/profile data.
 */
export function applyJsonMergePatch(target: LooseRecord, patch: LooseRecord): LooseRecord {
  const out: LooseRecord = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      out[key] = applyJsonMergePatch(current as LooseRecord, value as LooseRecord);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      out[key] = applyJsonMergePatch({}, value as LooseRecord);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Assemble a chat-model manifest from its config, freshly fetched provider
 * blocks, and (optionally) the manifest currently on disk. Non-lossy by
 * default: see the module header for the ownership model.
 */
export function assembleManifest(input: AssembleInput): AssembleResult {
  const { cfg, providerBlocks, existing = null, reseed = false } = input;
  const manifest: LooseRecord = {
    schemaVersion: 1,
    kind: 'chat-model',
    id: cfg.id,
  };
  const preservedFromManifest: string[] = [];
  const carriedRevisions: string[] = [];

  // Base + editorial fields. The existing manifest is authoritative unless
  // `reseed` is set; in either mode a value the winning side lacks falls
  // through to the other side rather than being dropped.
  for (const field of [...BASE_FIELDS, ...EDITORIAL_FIELDS]) {
    const fromExisting = existing?.[field];
    const fromCfg = cfg[field];
    const hasExisting = fromExisting !== undefined;
    const hasCfg = fromCfg !== undefined;
    if (reseed) {
      if (hasCfg) manifest[field] = fromCfg;
      else if (hasExisting) {
        manifest[field] = fromExisting;
        preservedFromManifest.push(field);
      }
    } else if (hasExisting) {
      manifest[field] = fromExisting;
      // Only flag as "preserved" when it actually shadows a config value or
      // is manifest-only — a field both sides agree on isn't interesting.
      if (!hasCfg || JSON.stringify(fromExisting) !== JSON.stringify(fromCfg)) {
        preservedFromManifest.push(field);
      }
    } else if (hasCfg) {
      manifest[field] = fromCfg;
    }
  }

  // Provider blocks: freshly fetched file data wins, revision pin preserved.
  for (const key of PROVIDER_FIELDS) {
    const fresh = providerBlocks[key];
    if (!fresh) continue;
    const previousBlock = existing?.[key] as LooseRecord | undefined;
    const prevRev = previousBlock?.revision;
    const sameRepo =
      previousBlock?.huggingfaceRepo === undefined ||
      fresh.huggingfaceRepo === previousBlock.huggingfaceRepo;
    if (typeof prevRev === 'string' && fresh.revision === undefined && sameRepo) {
      manifest[key] = carryRevision(fresh, prevRev);
      carriedRevisions.push(key);
    } else {
      manifest[key] = fresh;
    }
  }

  return { manifest, preservedFromManifest, carriedRevisions };
}

/**
 * Strip the `revision` pin out of a manifest's provider blocks, returning
 * them in the shape `build-manifest` produces from a fresh HF fetch (which
 * never includes a revision). Used by the rebuild-safety test to simulate
 * a refresh; also handy for tooling that wants the un-pinned blocks.
 */
export function providerBlocksWithoutRevision(manifest: LooseRecord): ProviderBlocks {
  const out: ProviderBlocks = {};
  for (const key of PROVIDER_FIELDS) {
    const block = manifest[key] as LooseRecord | undefined;
    if (!block) continue;
    const { revision: _drop, ...rest } = block;
    out[key] = rest;
  }
  return out;
}
