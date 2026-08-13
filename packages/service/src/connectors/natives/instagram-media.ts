/**
 * Instagram (API with Instagram Login) as a `native` connector adapter: the
 * professional account's media — posts, reels, carousels — plus a daily
 * account-stats series, normalized into the shared social corpus shape. Raw
 * `fetch` against graph.instagram.com through an injectable runtime seam — no
 * platform SDK, mirroring bluesky-posts and x-posts.
 *
 * Auth is Meta's long-lived-token contract, not refresh tokens: the OAuth
 * link flow (ConnectorManager.completeOAuth + oauth.ts's
 * `exchangeLongLivedToken`) stores `{accessToken, expiresAt, refreshMode:
 * 'long-lived-exchange', refreshUrl}`, and `ensureAuth` here renews the token
 * in place (`ig_refresh_token`) once under 7 days remain, re-persisting the
 * blob. Media bodies are caption + permalink only in v1 — files are never
 * downloaded (`downloadMedia` is reserved), matching Bluesky's precedent.
 *
 * Publishing is real but rides Meta's public-URL contract: the two-step
 * container flow (`POST /me/media` → `POST /me/media_publish`) has Meta's
 * servers FETCH the image from a public https URL — a local-first app hosts
 * nothing, so a publish needs an already-hosted `imageUrl`, and caption-only
 * posts do not exist on Instagram. The `publish` action goes through the
 * consent-gated `social-publish` scope (off until the binding enables
 * `allowPublish`). Each observed media item additionally leaves a per-(post,
 * day) engagement-history record unless `metricsHistory` is off.
 */

import { isRateLimitStatus } from '@bendyline/gezel';
import { expiresAtFrom } from '../oauth.js';
import { connectorSecretKey, registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import {
  firstLineTitle,
  metricsHistoryRecord,
  monthSegments,
  orderedFrontmatter,
  postFileStem,
  windowRefreshDue,
} from './social-shared.js';

const API_ORIGIN = 'https://graph.instagram.com';
const API_BASE = `${API_ORIGIN}/v23.0`;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_PASS = 20;
const MEDIA_FIELDS =
  'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count';
/** Long-lived tokens last ~60 days; renew once under this much remains. */
const REFRESH_MARGIN_MS = 7 * 86_400_000;

interface InstagramConfig {
  /** Reserved: v1 never downloads media files (captions + permalinks only). */
  downloadMedia: boolean;
  maxMedia: number;
  metricsWindowDays: number;
  metricsRefreshHours: number;
  statsIntervalHours: number;
  metricsHistory: boolean;
  allowPublish: boolean;
}

interface InstagramCred {
  accessToken: string;
  expiresAt?: string;
  refreshMode?: string;
  refreshUrl?: string;
}

/** A non-2xx graph.instagram.com response; Meta's body `error.code` rides along. */
export class InstagramApiError extends Error {
  constructor(
    readonly status: number,
    readonly igCode: number | undefined,
    detail: string,
  ) {
    super(`instagram api ${status}${igCode !== undefined ? ` (code ${igCode})` : ''}: ${detail}`);
    this.name = 'InstagramApiError';
  }
}

/** The slice of the outside world the adapter consumes (injectable for tests). */
export interface InstagramRuntime {
  /** GET a graph URL (access token in the query); parsed JSON out; InstagramApiError on !ok. */
  getJson(url: string): Promise<unknown>;
  /** POST a form-encoded body to a graph URL; same parse + error shape. */
  postForm(url: string, form: Record<string, string>): Promise<unknown>;
  now(): Date;
}

async function graphJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => '');
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON error bodies fall through to the status-only error below.
  }
  if (!res.ok) {
    const errView = ((json ?? {}) as { error?: { message?: unknown; code?: unknown } }).error;
    const code = typeof errView?.code === 'number' ? errView.code : undefined;
    const message = typeof errView?.message === 'string' ? errView.message : text.slice(0, 300);
    throw new InstagramApiError(res.status, code, message);
  }
  return json;
}

const defaultRuntime: InstagramRuntime = {
  getJson: (url) => graphJson(url),
  postForm: (url, form) =>
    graphJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  now: () => new Date(),
};

interface MediaCursor {
  sinceTs?: string;
  metricsRefreshedAt?: string;
}

interface StatsCursor {
  lastFetchAt: string;
  lastDay: string;
}

export class InstagramMediaAdapter implements ConnectorAdapter {
  readonly typeId = 'instagram-media';
  private config?: InstagramConfig;
  private token = '';
  /** One timestamp per pass so every refreshed record carries the same stamp. */
  private syncedAt = '';

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: InstagramRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const key = connectorSecretKey(this.binding.type, this.binding.id);
    const blob = await this.deps.secrets.get(key);
    if (!blob) {
      throw new Error(
        `No stored credential for Instagram connector ${this.binding.id}. Re-link the account from the connector's settings.`,
      );
    }
    let cred = JSON.parse(blob) as InstagramCred;
    if (!cred.accessToken) {
      throw new Error(
        `The stored Instagram credential for ${this.binding.id} has no access token. Re-link the account.`,
      );
    }
    const now = this.runtime.now();
    if (
      cred.refreshMode === 'long-lived-exchange' &&
      cred.refreshUrl &&
      longLivedRefreshDue(cred.expiresAt, now)
    ) {
      const refreshed = await this.refreshLongLived(cred.refreshUrl, cred.accessToken);
      cred = { ...cred, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
      await this.deps.secrets.set(key, JSON.stringify(cred));
    }
    this.token = cred.accessToken;
    this.syncedAt = now.toISOString();
  }

  async listScopes(): Promise<string[]> {
    this.assertReady();
    return ['media', 'stats'];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    try {
      if (scope === 'media') return await this.listMedia(cursor, opts);
      if (scope === 'stats') return await this.listStats(cursor);
      return { records: [], cursor };
    } catch (err) {
      if (isRateLimitError(err)) return { records: [], cursor, rateLimited: true };
      throw err;
    }
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    this.assertReady();
    if (scope === 'media') {
      const prebuilt = prebuiltMetricsRecord(ref.raw);
      if (prebuilt) return prebuilt;
      return mediaToRecord(ref.raw, { metricsUpdatedAt: this.syncedAt });
    }
    if (scope === 'stats') {
      const raw = (ref.raw ?? {}) as { profile?: unknown; day?: unknown };
      return profileToStatsRecord(raw.profile, typeof raw.day === 'string' ? raw.day : '');
    }
    throw new Error(`unknown instagram-media scope '${scope}'`);
  }

  async runAction(action: string, input: unknown): Promise<unknown> {
    if (action !== 'publish') {
      throw new Error(`instagram-media declares no action '${action}'`);
    }
    const config = this.assertReady();
    // The social-publish consent enforcer already gates the commit; this is
    // defense-in-depth for any future non-outbox caller.
    if (!config.allowPublish) {
      throw new Error(
        "Publishing is disabled on this Instagram connector. Enable 'Allow publishing' in the connector's settings first.",
      );
    }
    const parsed = parsePublishInput(input);
    // Two-step Graph publish: create a media container (Meta's servers fetch
    // the image from the public URL), then publish the container.
    const container = (await this.runtime.postForm(`${API_BASE}/me/media`, {
      image_url: parsed.imageUrl,
      ...(parsed.caption ? { caption: parsed.caption } : {}),
      access_token: this.token,
    })) as { id?: unknown };
    const creationId = typeof container.id === 'string' ? container.id : '';
    if (!creationId) {
      throw new Error(
        'Instagram returned no media container id; check that the image URL is publicly reachable.',
      );
    }
    const published = (await this.runtime.postForm(`${API_BASE}/me/media_publish`, {
      creation_id: creationId,
      access_token: this.token,
    })) as { id?: unknown };
    const mediaId = typeof published.id === 'string' ? published.id : '';
    if (!mediaId) {
      throw new Error(
        'Instagram did not confirm the publish; check the account before drafting again.',
      );
    }
    const permalink = await this.fetchPermalink(mediaId);
    return { id: mediaId, ...(permalink ? { permalink } : {}) };
  }

  async close(): Promise<void> {}

  private assertReady(): InstagramConfig {
    if (!this.config || !this.token) {
      throw new Error('Instagram connector has not been initialized.');
    }
    return this.config;
  }

  private async refreshLongLived(
    refreshUrl: string,
    current: string,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    let url: URL;
    try {
      url = new URL(refreshUrl);
    } catch {
      throw new Error('The stored Instagram refresh URL is invalid. Re-link the account.');
    }
    if (url.protocol !== 'https:') {
      throw new Error('The stored Instagram refresh URL must be HTTPS. Re-link the account.');
    }
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', current);
    let json: unknown;
    try {
      json = await this.runtime.getJson(url.toString());
    } catch (err) {
      const detail = err instanceof Error ? ` ${err.message}` : '';
      throw new Error(
        `Instagram token refresh failed — re-link the account if this persists.${detail}`,
      );
    }
    const view = (json ?? {}) as { access_token?: unknown; expires_in?: unknown };
    const accessToken = typeof view.access_token === 'string' ? view.access_token : '';
    if (!accessToken) {
      throw new Error('Instagram token refresh returned no access token. Re-link the account.');
    }
    return { accessToken, expiresAt: expiresAtFrom(view.expires_in) };
  }

  /** Best-effort permalink for a just-published media id — the post is live
   *  either way; only the receipt link is missing on failure. */
  private async fetchPermalink(mediaId: string): Promise<string | undefined> {
    try {
      const url = new URL(`${API_BASE}/${encodeURIComponent(mediaId)}`);
      url.searchParams.set('fields', 'permalink');
      url.searchParams.set('access_token', this.token);
      const res = (await this.runtime.getJson(url.toString())) as { permalink?: unknown };
      return typeof res.permalink === 'string' && res.permalink ? res.permalink : undefined;
    } catch {
      return undefined;
    }
  }

  private async listMedia(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<MediaCursor>> {
    const config = this.assertReady();
    const prior = parseMediaCursor(cursorRaw);
    const now = this.runtime.now();
    const sinceMs = tsMs(prior?.sinceTs);
    const limit = Math.max(1, Math.min(opts?.limit ?? config.maxMedia, config.maxMedia));
    // The first pass is one bounded backfill; it observes metrics for
    // everything it fetches, so the refresh window starts counting from it.
    const metricsDue =
      sinceMs !== undefined &&
      windowRefreshDue(prior?.metricsRefreshedAt, config.metricsRefreshHours, now);
    const windowFloorMs = now.getTime() - config.metricsWindowDays * 86_400_000;

    const records: RecordRef[] = [];
    const seen = new Set<string>();
    let newestTs = prior?.sinceTs;
    let newestMs = sinceMs ?? Number.NEGATIVE_INFINITY;
    let nextUrl: string | undefined = this.firstMediaPageUrl();
    let exhausted = false;

    for (
      let page = 0;
      page < MAX_PAGES_PER_PASS && nextUrl && !exhausted && records.length < limit;
      page++
    ) {
      const res = (await this.runtime.getJson(nextUrl)) as {
        data?: unknown[];
        paging?: { next?: unknown };
      };
      const items = Array.isArray(res.data) ? res.data : [];
      for (const item of items) {
        const scan = scanMedia(item);
        if (!scan) continue;
        if (scan.tsMs > newestMs) {
          newestMs = scan.tsMs;
          newestTs = scan.tsIso;
        }
        // The feed is newest-first; once past both the incremental floor and
        // the metrics window there is nothing left to want.
        if (
          sinceMs !== undefined &&
          scan.tsMs <= sinceMs &&
          (!metricsDue || scan.tsMs < windowFloorMs)
        ) {
          exhausted = true;
          break;
        }
        if (seen.has(scan.id)) continue;
        const isNew = sinceMs === undefined || scan.tsMs > sinceMs;
        const inWindow = metricsDue && scan.tsMs >= windowFloorMs;
        if (!isNew && !inWindow) continue;
        seen.add(scan.id);
        records.push({ id: scan.id, raw: item, ts: scan.tsIso, ordinalKey: scan.tsMs });
        if (records.length >= limit) break;
      }
      if (!exhausted) {
        const next = typeof res.paging?.next === 'string' ? res.paging.next : '';
        // Meta's `paging.next` embeds the access token; follow it only on the
        // API's own origin so the credential cannot be redirected.
        nextUrl = next && isApiOrigin(next) ? next : undefined;
        if (!nextUrl || items.length === 0) exhausted = true;
      }
    }

    const cursor: MediaCursor = {
      ...(newestTs ? { sinceTs: newestTs } : {}),
      ...(metricsDue || sinceMs === undefined
        ? { metricsRefreshedAt: now.toISOString() }
        : prior?.metricsRefreshedAt
          ? { metricsRefreshedAt: prior.metricsRefreshedAt }
          : {}),
    };
    const out = config.metricsHistory
      ? [...records, ...this.metricsHistoryRefs(records, limit - records.length)]
      : records;
    return { records: out, cursor };
  }

  /**
   * One prebuilt engagement-history record per observed media item, riding the
   * same batch (fetchRecord passes them through untouched). Budgeted to the
   * pass's leftover headroom under `limit`: the engine slices every batch
   * newest-first at its backfill cap, and history rows (ordinal = now) would
   * displace real media past it — the cursor still advances, so displaced
   * items would never be fetched again. On a cap-sized backfill the counts
   * already live on the media records; the history series starts a pass later.
   */
  private metricsHistoryRefs(records: RecordRef[], room: number): RecordRef[] {
    if (room <= 0) return [];
    const observedAt = this.syncedAt;
    const ordinalKey = Date.parse(observedAt);
    return [...records]
      .sort((a, b) => (b.ordinalKey ?? 0) - (a.ordinalKey ?? 0))
      .slice(0, room)
      .map((item) => {
        const record = mediaMetricsRecord(item.raw, { observedAt });
        return { id: record.recordId, raw: { metricsHistory: record }, ts: observedAt, ordinalKey };
      });
  }

  private firstMediaPageUrl(): string {
    const url = new URL(`${API_BASE}/me/media`);
    url.searchParams.set('fields', MEDIA_FIELDS);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('access_token', this.token);
    return url.toString();
  }

  private async listStats(cursorRaw: unknown): Promise<ChangeBatch<StatsCursor>> {
    const config = this.assertReady();
    const prior = parseStatsCursor(cursorRaw);
    const now = this.runtime.now();
    if (prior && !windowRefreshDue(prior.lastFetchAt, config.statsIntervalHours, now)) {
      return { records: [], cursor: prior };
    }
    const url = new URL(`${API_BASE}/me`);
    url.searchParams.set('fields', 'username,followers_count,follows_count,media_count');
    url.searchParams.set('access_token', this.token);
    const profile = await this.runtime.getJson(url.toString());
    const day = localDay(now);
    return {
      records: [
        {
          id: `stats-${day}`,
          raw: { profile, day },
          ts: now.toISOString(),
          ordinalKey: now.getTime(),
        },
      ],
      cursor: { lastFetchAt: now.toISOString(), lastDay: day },
    };
  }
}

// ── config + cursor parsing ────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown> | undefined): InstagramConfig {
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  return {
    downloadMedia: raw?.downloadMedia === true,
    maxMedia: Math.floor(num(raw?.maxMedia, 200, 1, 10_000)),
    metricsWindowDays: num(raw?.metricsWindowDays, 30, 1, 365),
    metricsRefreshHours: num(raw?.metricsRefreshHours, 12, 0.25, 24 * 30),
    statsIntervalHours: num(raw?.statsIntervalHours, 6, 0.25, 24 * 30),
    metricsHistory: raw?.metricsHistory !== false,
    allowPublish: raw?.allowPublish === true,
  };
}

interface PublishInput {
  imageUrl: string;
  caption?: string;
}

function parsePublishInput(input: unknown): PublishInput {
  if (!input || typeof input !== 'object') {
    throw new Error('publish input must be an object with an imageUrl field');
  }
  const value = input as Record<string, unknown>;
  const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl.trim() : '';
  if (!imageUrl) {
    throw new Error(
      "publish requires imageUrl: a publicly hosted https URL of the image to post. Instagram's servers fetch the media from that URL — Gezel cannot upload local files, and caption-only posts do not exist on Instagram.",
    );
  }
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new Error(
      `publish imageUrl must be an absolute https URL Instagram's servers can fetch; '${imageUrl}' is not an absolute URL. Host the image publicly (any CDN or static host) and draft again.`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `publish imageUrl must use https — Instagram's servers fetch the media and refuse '${url.protocol}' URLs. Host the image on a public https URL and draft again.`,
    );
  }
  // The generic draft flow (draft_post) carries the caption as the draft's
  // post text; accept both spellings, preferring an explicit `caption`.
  const caption =
    typeof value.caption === 'string' && value.caption
      ? value.caption
      : typeof value.text === 'string'
        ? value.text
        : '';
  return { imageUrl, ...(caption ? { caption } : {}) };
}

function parseMediaCursor(raw: unknown): MediaCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const sinceTs = typeof value.sinceTs === 'string' && value.sinceTs ? value.sinceTs : undefined;
  const metricsRefreshedAt =
    typeof value.metricsRefreshedAt === 'string' && value.metricsRefreshedAt
      ? value.metricsRefreshedAt
      : undefined;
  if (!sinceTs && !metricsRefreshedAt) return undefined;
  return {
    ...(sinceTs ? { sinceTs } : {}),
    ...(metricsRefreshedAt ? { metricsRefreshedAt } : {}),
  };
}

function parseStatsCursor(raw: unknown): StatsCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  return typeof value.lastFetchAt === 'string' &&
    value.lastFetchAt &&
    typeof value.lastDay === 'string'
    ? { lastFetchAt: value.lastFetchAt, lastDay: value.lastDay }
    : undefined;
}

// ── scanning helpers ───────────────────────────────────────────────────────

function tsMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isApiOrigin(url: string): boolean {
  try {
    return new URL(url).origin === API_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Meta throttling: HTTP 429/503, or an error body with code 4 (application
 * cap), 17 (user cap), or 32 (page cap) riding an ordinary 4xx status.
 */
const META_THROTTLE_CODES = new Set([4, 17, 32]);

function isRateLimitError(err: unknown): boolean {
  const view = (err ?? null) as { status?: unknown; igCode?: unknown } | null;
  if (typeof view?.status === 'number' && isRateLimitStatus(view.status)) return true;
  return typeof view?.igCode === 'number' && META_THROTTLE_CODES.has(view.igCode);
}

interface MediaScan {
  id: string;
  tsIso: string;
  tsMs: number;
}

function scanMedia(item: unknown): MediaScan | null {
  if (!item || typeof item !== 'object') return null;
  const view = item as { id?: unknown; timestamp?: unknown };
  const id = typeof view.id === 'string' ? view.id : '';
  const tsIso = typeof view.timestamp === 'string' ? view.timestamp : '';
  const ms = tsMs(tsIso);
  if (!id || ms === undefined) return null;
  return { id, tsIso, tsMs: ms };
}

/** ~60-day tokens renew in place; missing/unparseable expiry counts as due. */
function longLivedRefreshDue(expiresAt: string | undefined, now: Date): boolean {
  const ms = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(ms)) return true;
  return ms - now.getTime() < REFRESH_MARGIN_MS;
}

// ── pure record mappers (golden-tested; plain JSON in, NormalizedRecord out) ─

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const count = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';

const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Detect a prebuilt metrics-history record riding a RecordRef's raw. */
function prebuiltMetricsRecord(raw: unknown): NormalizedRecord | undefined {
  const view = (raw ?? null) as { metricsHistory?: unknown } | null;
  return view?.metricsHistory && typeof view.metricsHistory === 'object'
    ? (view.metricsHistory as NormalizedRecord)
    : undefined;
}

export interface MediaRecordOptions {
  /** ISO timestamp of this sync pass — when the counts were observed. */
  metricsUpdatedAt: string;
}

/** Map one `/me/media` item to a corpus record (caption + permalink only). */
export function mediaToRecord(item: unknown, opts: MediaRecordOptions): NormalizedRecord {
  const media = (item ?? {}) as {
    id?: unknown;
    caption?: unknown;
    media_type?: unknown;
    permalink?: unknown;
    timestamp?: unknown;
    like_count?: unknown;
    comments_count?: unknown;
  };
  const id = str(media.id);
  if (!id) throw new Error('Instagram media item is missing its id.');
  const caption = str(media.caption);
  const mediaType = str(media.media_type);
  const timestamp = str(media.timestamp);
  const permalink = str(media.permalink);

  const frontmatter = orderedFrontmatter([
    ['title', firstLineTitle(caption) || mediaType || 'Media'],
    ['date', timestamp],
    ['platform', 'instagram'],
    ['media_id', id],
    ['media_type', mediaType || undefined],
    ['permalink', permalink || undefined],
    ['likes', count(media.like_count)],
    ['comments', count(media.comments_count)],
    ['has_media', true],
    ['metrics_updated_at', opts.metricsUpdatedAt],
  ]);

  return {
    recordId: id,
    dirSegments: monthSegments(timestamp),
    fileStem: postFileStem(timestamp, caption || mediaType.toLowerCase() || 'media'),
    frontmatter,
    // Caption + permalink only in this version — media files are never
    // downloaded (`downloadMedia` is reserved).
    bodyMarkdown: [caption, permalink].filter(Boolean).join('\n\n'),
    scanOrigin: 'instagram-media',
    quarantineNamespace: 'instagram-media',
    quarantineLabel: `Instagram post ${id}`,
  };
}

/** Map one `/me/media` item to the day's engagement-history observation. */
export function mediaMetricsRecord(item: unknown, opts: { observedAt: string }): NormalizedRecord {
  const media = (item ?? {}) as {
    id?: unknown;
    caption?: unknown;
    media_type?: unknown;
    permalink?: unknown;
    like_count?: unknown;
    comments_count?: unknown;
  };
  const id = str(media.id);
  if (!id) throw new Error('Instagram media item is missing its id.');
  const caption = str(media.caption);
  const permalink = str(media.permalink);
  return metricsHistoryRecord(
    {
      platform: 'instagram',
      postId: id,
      ...(permalink ? { permalink } : {}),
      title: firstLineTitle(caption) || str(media.media_type),
      observedAt: opts.observedAt,
      counts: [
        ['likes', numeric(media.like_count)],
        ['comments', numeric(media.comments_count)],
      ],
    },
    {
      scanOrigin: 'instagram-media',
      quarantineNamespace: 'instagram-media',
      quarantineLabel: 'Metrics reading',
    },
  );
}

/** Map one `/me?fields=…` profile payload to the day's stats record. */
export function profileToStatsRecord(profile: unknown, day: string): NormalizedRecord {
  const view = (profile ?? {}) as {
    username?: unknown;
    followers_count?: unknown;
    follows_count?: unknown;
    media_count?: unknown;
  };
  const username = str(view.username);
  const followers = count(view.followers_count);
  const following = count(view.follows_count);
  const postsCount = count(view.media_count);

  const frontmatter = orderedFrontmatter([
    ['title', `Account stats ${day}`],
    ['date', day],
    ['platform', 'instagram'],
    ['author', username || undefined],
    ['followers', followers],
    ['following', following],
    ['posts_count', postsCount],
  ]);

  return {
    recordId: `stats-${day}`,
    dirSegments: monthSegments(day),
    fileStem: `stats-${day}`,
    frontmatter,
    // Derived from the counts alone, so an unchanged same-day refresh hashes
    // identical and is skipped rather than rewritten.
    bodyMarkdown: `Followers: ${followers}\nFollowing: ${following}\nPosts: ${postsCount}`,
    scanOrigin: 'instagram-media',
    quarantineNamespace: 'instagram-media',
    quarantineLabel: `Instagram account stats for @${username || 'account'}`,
  };
}

/** Register the Instagram native adapter. */
export function registerInstagramAdapters(): void {
  registerNativeAdapter('instagram-media', async (binding, deps) =>
    Promise.resolve(new InstagramMediaAdapter(binding, deps)),
  );
}
