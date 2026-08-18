/**
 * Behavior registry — single source of truth for "what runtime
 * behaviors exist" and the resolver that turns a model's manifest-
 * declared `behaviors[]` array into a {@link ResolvedModelProfile}
 * the chat manager threads through `LiveSessionState`.
 *
 * The registry itself is populated from `behaviors/index.ts` (one
 * import per behavior file). Adding a behavior is a two-line change:
 * add the file under `behaviors/`, append its export to that index.
 *
 * Resolution flow:
 *
 *   1. {@link resolveProfile} reads the chat-model catalog manifest
 *      via the existing `CatalogService.get('chat-model', id)` call —
 *      no new I/O, the catalog is already cached.
 *   2. If the manifest has `behaviors`, walk each entry: normalize the
 *      `string | { id, config? }` union to `{ id, config }`, look up
 *      the registry entry, validate `config` via the behavior's
 *      `configSchema` (applying `defaultConfig` for missing keys),
 *      and produce a {@link ResolvedBehaviorEntry}.
 *   3. If the manifest has NO `behaviors`, fall back to the
 *      tier-keyed default list from {@link TIER_DEFAULT_BEHAVIORS}
 *      so unknown / third-party catalog imports keep working.
 *
 * Style fields follow the same pattern: manifest-declared `style`
 * wins; otherwise, {@link defaultStyleForProvider} fills in.
 */

import type { BehaviorEntry, BehaviorId, ChatModelManifest, ProviderName } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ModelTier } from '../chat/local-model-tier.js';
import { ALL_BEHAVIORS } from './behaviors/index.js';
import { TIER_DEFAULT_BEHAVIORS, defaultStyleForProvider } from './defaults.js';
import type { Behavior, ResolvedBehaviorEntry, ResolvedModelProfile } from './types.js';

const log = createLogger('model-profile');

/**
 * The registry. Built once at module load from `ALL_BEHAVIORS`. New
 * behaviors register by appending to {@link ALL_BEHAVIORS} in
 * `behaviors/index.ts` — no other call sites change.
 */
const BEHAVIORS: ReadonlyMap<BehaviorId, Behavior<unknown>> = (() => {
  const map = new Map<BehaviorId, Behavior<unknown>>();
  for (const b of ALL_BEHAVIORS) {
    if (map.has(b.id)) {
      throw new Error(
        `[model-profile] duplicate behavior id "${b.id}" — every entry in ALL_BEHAVIORS must be unique`,
      );
    }
    map.set(b.id, b as Behavior<unknown>);
  }
  return map;
})();

/**
 * Look up a behavior by id. Returns `undefined` for ids that aren't
 * registered — callers should treat that as "skip this entry"
 * (probably a typo or a behavior shipped in a future engine
 * version), not an error.
 */
export function lookupBehavior(id: BehaviorId): Behavior<unknown> | undefined {
  return BEHAVIORS.get(id);
}

/**
 * Behaviors defaulted ON for EVERY resolved profile — every model, every
 * provider, including cloud/frontier and third-party imports with no
 * manifest. Appended (deduped) in {@link resolveProfile} AFTER the
 * manifest / tier-default resolution, so an explicit manifest entry (with
 * its own config) always wins over the bare default.
 *
 * This is the "ship it on by default" switch for `tools.gezels-as-roles`
 * — role-typed delegation tools, validated to improve delegation on
 * gemma4-12b-q4 (two A/B runs: more delegation, 100% correct routing,
 * pass-rate 9/18→14/18, no regression) and hypothesized to help frontier
 * models too (to be tested). Opt out per-run via
 * `GEZEL_REMOVE_BEHAVIORS=tools.gezels-as-roles`.
 */
const UNIVERSAL_DEFAULT_BEHAVIORS: readonly BehaviorId[] = [
  'tools.gezels-as-roles',
  // Self-gating (isMeester + procedure/recurrence regex): inert on every
  // other turn, so it's safe on all models. Appended AFTER manifest
  // entries, so a manifest's build prelude keeps claiming generic
  // "build me X" turns first.
  'prompt.meester-craftbook-prelude',
  // Self-gating on resolved library matches, which the manager only supplies
  // for user-origin turns above a high similarity floor — so this is silent
  // on the overwhelming majority of turns and costs nothing when quiet.
  // Listed LAST so the meester's build/craftbook preludes keep claiming the
  // turns they route (first non-null wins).
  'prompt.library-recall-prelude',
];

/** Every behavior known to this engine. Useful for tooling, registry overviews, tests. */
export function listBehaviors(): ReadonlyArray<Behavior<unknown>> {
  return Array.from(BEHAVIORS.values());
}

/**
 * Normalize a {@link BehaviorEntry} from the manifest's union shape
 * to `{ id, config }`. Bare strings become `{ id, config: undefined }`.
 */
function normalizeEntry(entry: BehaviorEntry): { id: BehaviorId; config: unknown } {
  if (typeof entry === 'string') return { id: entry, config: undefined };
  return { id: entry.id, config: entry.config };
}

/**
 * Validate a behavior's config against its declared Zod schema. When
 * the manifest didn't supply a config, fall back to the behavior's
 * `defaultConfig` (or `undefined` for switch-style behaviors).
 *
 * Validation failures get logged + the entry is dropped — a malformed
 * manifest shouldn't take the entire session down. The parent profile
 * still resolves with the rest of the behaviors.
 */
function validateConfig(
  behavior: Behavior<unknown>,
  config: unknown,
  catalogId: string | undefined,
): { ok: true; config: unknown } | { ok: false } {
  // Switch-style behavior: no schema, no config expected. Forward
  // undefined — the hook signatures take `void` and the value is
  // ignored.
  if (!behavior.configSchema) {
    return { ok: true, config: undefined };
  }
  // Manifest didn't supply config — fall back to defaultConfig if
  // the behavior provides one.
  const candidate = config === undefined ? behavior.defaultConfig : config;
  const parsed = behavior.configSchema.safeParse(candidate);
  if (!parsed.success) {
    log.warn(
      `[model-profile] behavior "${behavior.id}" on catalogId="${catalogId ?? '<none>'}" had invalid config; dropping. Issues: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    return { ok: false };
  }
  return { ok: true, config: parsed.data };
}

/**
 * Walk a list of {@link BehaviorEntry} (from a manifest or from the
 * tier-default fallback) and produce the resolved triples. Shared
 * pipeline so config validation rules stay in one place.
 */
function resolveEntries(
  entries: ReadonlyArray<BehaviorEntry>,
  catalogId: string | undefined,
): ResolvedBehaviorEntry[] {
  const out: ResolvedBehaviorEntry[] = [];
  for (const entry of entries) {
    const { id, config } = normalizeEntry(entry);
    const behavior = BEHAVIORS.get(id);
    if (!behavior) {
      log.warn(
        `[model-profile] catalogId="${catalogId ?? '<none>'}" referenced unknown behavior "${id}"; skipping. Either the engine is older than the manifest, the behavior file isn't registered in ALL_BEHAVIORS yet, or there's a typo.`,
      );
      continue;
    }
    const verdict = validateConfig(behavior, config, catalogId);
    if (!verdict.ok) continue;
    out.push({ id, config: verdict.config, behavior });
  }
  return out;
}

/**
 * Resolve the {@link ResolvedModelProfile} for a session. Called once
 * by `buildSessionOpts()` and cached on `LiveSessionState.profile`.
 *
 * `manifest` is what the catalog returned (typed via the catalog
 * package's `CatalogItemDetail` for chat-model kinds). Pass
 * `undefined` when no catalog entry exists — the fallback path
 * generates a tier-default profile.
 */
export function resolveProfile(args: {
  manifest: ChatModelManifest | undefined;
  tier: ModelTier;
  providerName: ProviderName;
}): ResolvedModelProfile {
  const { manifest, tier, providerName } = args;
  const catalogId = manifest?.id;

  // No manifest, or manifest with no behaviors — fall back to the
  // tier default. Preserves backward compat with every existing
  // catalog entry that hasn't been re-generated yet.
  const sourceEntries: ReadonlyArray<BehaviorEntry> =
    manifest?.behaviors && manifest.behaviors.length > 0
      ? manifest.behaviors
      : TIER_DEFAULT_BEHAVIORS[tier];

  // Append the universal defaults (deduped — a manifest/tier entry for the
  // same id wins, keeping its config). This is how `tools.gezels-as-roles`
  // reaches every model regardless of manifest.
  const presentIds = new Set(sourceEntries.map((e) => (typeof e === 'string' ? e : e.id)));
  const mergedEntries: ReadonlyArray<BehaviorEntry> = [
    ...sourceEntries,
    ...UNIVERSAL_DEFAULT_BEHAVIORS.filter((id) => !presentIds.has(id)),
  ];

  const behaviors = resolveEntries(mergedEntries, catalogId);

  return {
    catalogId,
    tier,
    style: manifest?.style ?? defaultStyleForProvider(providerName),
    behaviors,
  };
}

/**
 * Convenience helper for tests + prompt-build sites that need the
 * resolved profile but don't already have a manifest in hand.
 * Looks the manifest up via the catalog service and forwards.
 */
export async function resolveProfileForCatalogId(args: {
  catalog: CatalogService;
  catalogId: string | undefined;
  tier: ModelTier;
  providerName: ProviderName;
}): Promise<ResolvedModelProfile> {
  const { catalog, catalogId, tier, providerName } = args;
  if (!catalogId) {
    return resolveProfile({ manifest: undefined, tier, providerName });
  }
  const detail = await catalog.get('chat-model', catalogId).catch(() => null);
  const manifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
  return resolveProfile({ manifest, tier, providerName });
}
