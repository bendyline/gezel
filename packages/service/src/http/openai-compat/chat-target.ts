import type { ProviderName } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

/**
 * Uniform target the `/v1/chat/completions` route uses to drive a
 * session. Whether the caller supplied a raw `<provider>:<model>` id
 * or a `gezel:<id-or-name>` reference, the route only deals with
 * this shape after the resolve step.
 */
export interface ChatTarget {
  provider: ProviderName;
  /** Provider-native model id; undefined for caller of `<provider>` bare default. */
  model: string | undefined;
  /**
   * Text prepended to the system message before any caller-supplied
   * `system` entries. Carries the gezel's persona (`about.md` body)
   * for `gezel:` routes; an empty string for raw model routes.
   */
  systemPrefix: string;
  /**
   * The gezel's frontmatter tuning knobs, present only for `gezel:`
   * routes. Fed into `ChatManager.resolveModelSessionDefaults` so a
   * gezel-targeted `/v1` request applies the same per-gezel sampling
   * overrides, tuning-profile pick, and reasoning effort a UI session
   * on that gezel would.
   */
  tuningOverrides?: {
    tuning?: NonNullable<GezelDetailForTarget['parsed']>['frontmatter']['tuning'];
    tuningProfileId?: string;
    suggestedProfileId?: string;
    reasoningEffort?: string;
  };
}

/** Structural slice of `Store.getGezel`'s return the target resolver reads. */
type GezelDetailForTarget = NonNullable<Awaited<ReturnType<ServiceContext['store']['getGezel']>>>;

export type ChatTargetInput =
  | { kind: 'gezel'; ref: string }
  | { kind: 'model'; provider: ProviderName; model: string | undefined };

/**
 * Pick the gezel that guarantees a persona-backed fallback for public
 * inference requests.
 *
 * The explicit Connected Apps choice wins. When it is unset or stale,
 * the install's Meester is the natural front door; the first available
 * gezel is the final recovery path for older or partially migrated
 * homes. A healthy store always has at least a Meester, but returning
 * `null` keeps callers honest if the home is temporarily empty.
 */
export async function resolveFallbackGezelId(
  ctx: ServiceContext,
  preferredGezelId?: string,
): Promise<string | null> {
  const config = await ctx.store.readConfig().catch(() => ({}) as { meesterGezelId?: string });
  const candidates = [preferredGezelId, config.meesterGezelId].filter(
    (id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index,
  );

  for (const id of candidates) {
    const gezel = await ctx.store.getGezel(id).catch(() => null);
    if (gezel) return gezel.id;
  }

  const gezels = await ctx.store.listGezels().catch(() => []);
  return gezels[0]?.id ?? null;
}

/**
 * Resolve a {@link ChatTargetInput} into a concrete {@link ChatTarget}.
 *
 * Gezel routing:
 *   - The `ref` may be the gezel's id (UUID-like) or its name (case-
 *     insensitive). Id wins on collision.
 *   - The gezel's frontmatter `provider` + `model` are honored when
 *     present; otherwise we delegate to {@link ChatManager.providerForGezel}
 *     so the install-level default applies (same path
 *     {@link ChatManager.oneShotCompletion} uses).
 *   - `about.md` becomes the system prefix so the gezel's voice steers
 *     the response. Tools / MCP wiring are NOT attached today —
 *     tool calling through `/v1` is out of scope until the ephemeral
 *     MCP bridge phase lands.
 *
 * Throws when the gezel can't be found so the route can map to a
 * `404 gezel_not_found`.
 */
export async function resolveChatTarget(
  input: ChatTargetInput,
  ctx: ServiceContext,
): Promise<ChatTarget> {
  if (input.kind === 'model') {
    return { provider: input.provider, model: input.model, systemPrefix: '' };
  }

  const gezel = await loadGezelByRef(input.ref, ctx);
  if (!gezel) {
    throw new Error(`gezel "${input.ref}" not found`);
  }

  const provider = await ctx.chat.providerForGezel(gezel.id);
  const config = await ctx.store
    .readConfig()
    .catch(() => ({}) as { defaultModel?: Record<string, string> });
  const model =
    gezel.parsed.frontmatter.model ?? (config.defaultModel?.[provider] as string | undefined);

  const persona = gezel.about?.trim() ?? '';
  const fm = gezel.parsed.frontmatter;
  return {
    provider,
    model,
    systemPrefix: persona,
    tuningOverrides: {
      ...(fm.tuning ? { tuning: fm.tuning } : {}),
      ...(fm.tuningProfile ? { tuningProfileId: fm.tuningProfile } : {}),
      ...(fm.suggestedTuningProfile ? { suggestedProfileId: fm.suggestedTuningProfile } : {}),
      ...(fm.reasoningEffort ? { reasoningEffort: fm.reasoningEffort } : {}),
    },
  };
}

async function loadGezelByRef(ref: string, ctx: ServiceContext) {
  // Try as-an-id first — that's the fast path.
  const byId = await ctx.store.getGezel(ref).catch(() => null);
  if (byId) return byId;

  // Fall back to a case-insensitive name match. Cheap because
  // `listGezels` returns summaries; we then load the matching detail.
  const list = await ctx.store.listGezels().catch(() => []);
  const lower = ref.toLowerCase();
  const summary = list.find((g) => g.name.toLowerCase() === lower);
  if (!summary) return null;
  return ctx.store.getGezel(summary.id).catch(() => null);
}
