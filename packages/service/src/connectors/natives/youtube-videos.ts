/**
 * YouTube channels as a `native` connector: each configured channel's
 * uploads, one record per video, read through the YouTube Data API v3 with
 * an API key. Public data only — captions, transcripts and analytics need
 * OAuth and channel ownership, which this connector does not ask for.
 *
 * The walk is the channel's uploads playlist (`contentDetails.relatedPlaylists
 * .uploads`), newest first, stopping at the newest videos the previous pass
 * already recorded; the new ids are then fetched in `videos.list` batches of
 * 50 for their snippet, duration, status and counts. Every call costs one
 * quota unit against a default 10,000 a day
 * (https://developers.google.com/youtube/v3/determine_quota_cost), and the
 * pass is interval-gated besides, so a checked channel with nothing new costs
 * a single unit.
 *
 * View, like and comment counts churn constantly, so they follow the x-posts
 * pattern rather than rewriting every record every pass: a video's record
 * carries the counts as of `metrics_updated_at`, and only videos published
 * inside `metricsWindowDays` — where the counts actually still move — are
 * re-read, at most every `metricsRefreshHours`, from a small watch list kept
 * in the cursor (a `videos.list` by id, no playlist re-walk). Older videos
 * keep their last observed counts and are never rewritten. With
 * `metricsHistory` on, each observation also leaves a per-(video, day)
 * record (social-shared's `metricsHistoryRecord`), so a curve survives the
 * refreshes.
 *
 * The API key travels in the `X-Goog-Api-Key` header, which Google
 * recommends over the `key=` query parameter precisely because URLs end up
 * in logs (https://docs.cloud.google.com/docs/authentication/api-keys-use).
 * No URL this adapter builds carries it, and error text from Google is
 * scrubbed of it besides.
 */

import { HttpStatusError, isRateLimitStatus } from '@bendyline/gezel';
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
import { formatSeconds } from './rss-feed.js';
import {
  firstLineTitle,
  metricsHistoryRecord,
  monthSegments,
  orderedFrontmatter,
  postFileStem,
  windowRefreshDue,
} from './social-shared.js';

export const YOUTUBE_TYPE_ID = 'youtube-videos';
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const PAGE_SIZE = 50;
const VIDEO_BATCH = 50;
const DEFAULT_LIMIT = 500;
/** Newest recorded ids kept as stop markers (a deleted marker must not restart the walk). */
const STOP_MARKERS = 20;
/** Videos watched for count refreshes; bounds the cursor, which lives in project.json. */
const WATCH_CAP = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

interface YouTubeConfig {
  channels: string[];
  syncIntervalHours: number;
  maxVideos: number;
  metricsWindowDays: number;
  metricsRefreshHours: number;
  metricsHistory: boolean;
}

function parseConfig(raw: Record<string, unknown> | undefined): YouTubeConfig {
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  const list = Array.isArray(raw?.channels)
    ? raw.channels.filter((v): v is string => typeof v === 'string')
    : typeof raw?.channels === 'string'
      ? raw.channels.split(/[\s,]+/)
      : [];
  return {
    channels: list.map((s) => s.trim()).filter(Boolean),
    syncIntervalHours: num(raw?.syncIntervalHours, 6, 0, 24 * 30),
    maxVideos: Math.floor(num(raw?.maxVideos, 500, 1, 20_000)),
    metricsWindowDays: num(raw?.metricsWindowDays, 14, 0, 365),
    metricsRefreshHours: num(raw?.metricsRefreshHours, 24, 1, 24 * 30),
    metricsHistory: raw?.metricsHistory === true,
  };
}

// ── channel specs ──────────────────────────────────────────────────────────

export type ChannelSpec =
  | { kind: 'id'; value: string }
  | { kind: 'handle'; value: string }
  | { kind: 'username'; value: string };

const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^@?[\p{L}\p{N}._-]{3,30}$/u;

/**
 * A configured channel as the API can look it up: a `UC…` channel id, an
 * `@handle`, or a legacy `/user/` name — typed bare or pasted as a channel
 * URL. Legacy `/c/` custom URLs have no lookup in the Data API (only a
 * 100-unit search could guess at them), so they are refused with a hint.
 */
export function parseChannelSpec(raw: string): ChannelSpec | { error: string } {
  const input = raw.trim();
  let candidate = input;
  if (/^(https?:\/\/)?((www|m)\.)?youtube\.com\//i.test(input)) {
    let path = '';
    try {
      path = new URL(/^https?:/i.test(input) ? input : `https://${input}`).pathname;
    } catch {
      return { error: `'${input.slice(0, 80)}' is not a YouTube channel address.` };
    }
    const parts = path
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    if (parts[0] === 'channel' && parts[1]) candidate = parts[1];
    else if (parts[0]?.startsWith('@')) candidate = parts[0];
    else if (parts[0] === 'user' && parts[1]) return { kind: 'username', value: parts[1] };
    else {
      return {
        error: `'${input.slice(0, 80)}' is a custom channel URL the YouTube API cannot look up. Use the channel's @handle or its UC… channel ID instead.`,
      };
    }
  }
  if (CHANNEL_ID.test(candidate)) return { kind: 'id', value: candidate };
  if (HANDLE.test(candidate)) {
    // Handles are case-insensitive; one spelling keeps one scope and cursor.
    return { kind: 'handle', value: `@${candidate.replace(/^@/, '').toLowerCase()}` };
  }
  return {
    error: `'${input.slice(0, 80)}' is neither a YouTube @handle nor a UC… channel ID.`,
  };
}

function specScope(spec: ChannelSpec): string {
  return spec.kind === 'username' ? `user:${spec.value}` : spec.value;
}

// ── errors ─────────────────────────────────────────────────────────────────

const THROTTLE_REASONS = new Set([
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);

const KEY_REASONS = new Set([
  'keyInvalid',
  'keyExpired',
  'API_KEY_INVALID',
  'API_KEY_EXPIRED',
  'accessNotConfigured',
  'SERVICE_DISABLED',
  'ipRefererBlocked',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
]);

/** The key was refused: every channel fails the same way, so the pass stops. */
export class YouTubeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeKeyError';
  }
}

/**
 * One channel (or its uploads playlist) does not exist. Fails that scope
 * only. Named with care: the engine's transient-retry classifier matches
 * `ENOTFOUND` case-insensitively against error names too, so a
 * `…NotFoundError` would be retried three times with backoff.
 */
export class YouTubeChannelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeChannelUnavailableError';
  }
}

/** A non-2xx Data API answer, with Google's error reasons kept for mapping. */
export class YouTubeApiError extends HttpStatusError {
  constructor(
    status: number,
    message: string,
    readonly reasons: string[],
  ) {
    super(status, message);
    this.name = 'YouTubeApiError';
  }
}

function isThrottle(err: unknown): boolean {
  if (err instanceof YouTubeApiError && err.reasons.some((r) => THROTTLE_REASONS.has(r))) {
    return true;
  }
  return err instanceof HttpStatusError && isRateLimitStatus(err.status);
}

/** Remove the key, and any `key=` parameter, from text that may be shown or logged. */
export function redactApiKey(text: string, key: string): string {
  let out = text.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1REDACTED');
  if (key.length >= 8) out = out.split(key).join('REDACTED');
  return out;
}

function toApiError(status: number, bodyText: string, resource: string, key: string): Error {
  let error: {
    message?: unknown;
    status?: unknown;
    errors?: { reason?: unknown }[];
    details?: { reason?: unknown }[];
  } = {};
  try {
    const parsed = JSON.parse(bodyText) as { error?: typeof error };
    if (parsed?.error && typeof parsed.error === 'object') error = parsed.error;
  } catch {
    /* not JSON: keep the status alone */
  }
  const reasons = [
    ...(Array.isArray(error.errors) ? error.errors : []).map((e) => e?.reason),
    ...(Array.isArray(error.details) ? error.details : []).map((d) => d?.reason),
    error.status,
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);
  // Google's quota message carries an HTML link; keep the words.
  const message = redactApiKey(
    (typeof error.message === 'string' ? error.message : '').replace(/<[^>]*>/g, ''),
    key,
  )
    .trim()
    .slice(0, 240);
  const detail = message || `HTTP ${status}`;
  if (reasons.some((r) => THROTTLE_REASONS.has(r)) || isRateLimitStatus(status)) {
    return new YouTubeApiError(status, `YouTube ${resource} is rate limited: ${detail}`, reasons);
  }
  if (reasons.includes('accessNotConfigured') || reasons.includes('SERVICE_DISABLED')) {
    return new YouTubeKeyError(
      `The YouTube Data API v3 is not enabled for this API key's Google Cloud project (${detail}). Enable it in the Google Cloud console, or check the API key credential in the connector's settings.`,
    );
  }
  if (
    reasons.some((r) => KEY_REASONS.has(r)) ||
    (status === 400 && /api key/i.test(message)) ||
    (status === 403 && /api key/i.test(message))
  ) {
    return new YouTubeKeyError(
      `YouTube refused this connector's API key (${detail}). Check the API key credential in the connector's settings: it must be a Google Cloud API key with the YouTube Data API v3 enabled.`,
    );
  }
  if (
    status === 404 ||
    reasons.includes('playlistNotFound') ||
    reasons.includes('channelNotFound')
  ) {
    return new YouTubeChannelUnavailableError(`YouTube ${resource}: ${detail}`);
  }
  return new YouTubeApiError(
    status,
    `YouTube ${resource} answered HTTP ${status}: ${detail}`,
    reasons,
  );
}

// ── cursor ─────────────────────────────────────────────────────────────────

/** `[video id, published ms]` — a video whose counts are still refreshed. */
type Watched = [id: string, ms: number];

export interface ChannelCursor {
  channelId: string;
  uploads: string;
  title: string;
  /** Newest recorded video ids, newest first: where the next walk stops. */
  seen?: string[];
  watch?: Watched[];
  lastFetchAt?: string;
  metricsRefreshedAt?: string;
  /** A walk the per-pass limit cut short; the next round resumes it. */
  walk?: { pageToken: string; listed: number; top: string[] };
}

function parseChannelCursor(raw: unknown): ChannelCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : undefined);
  const channelId = str('channelId');
  const uploads = str('uploads');
  if (!channelId || !uploads) return undefined;
  const ids = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  const watch = Array.isArray(v.watch)
    ? v.watch.filter(
        (e): e is Watched =>
          Array.isArray(e) &&
          typeof e[0] === 'string' &&
          typeof e[1] === 'number' &&
          Number.isFinite(e[1]),
      )
    : [];
  const walkRaw = (v.walk ?? null) as Record<string, unknown> | null;
  const walk =
    walkRaw && typeof walkRaw.pageToken === 'string' && walkRaw.pageToken
      ? {
          pageToken: walkRaw.pageToken,
          listed: typeof walkRaw.listed === 'number' ? walkRaw.listed : 0,
          top: ids(walkRaw.top),
        }
      : undefined;
  const lastFetchAt = str('lastFetchAt');
  const metricsRefreshedAt = str('metricsRefreshedAt');
  return {
    channelId,
    uploads,
    title: str('title') ?? '',
    seen: ids(v.seen),
    watch,
    ...(lastFetchAt ? { lastFetchAt } : {}),
    ...(metricsRefreshedAt ? { metricsRefreshedAt } : {}),
    ...(walk ? { walk } : {}),
  };
}

// ── records ────────────────────────────────────────────────────────────────

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Counts arrive as decimal strings; hidden ones (likes, disabled comments) are absent. */
const countOf = (value: unknown): number | undefined => {
  const n =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** ISO 8601 duration (`PT1H2M3S`, `P1DT2H`, `P0D`) → seconds. */
export function isoDurationSeconds(iso: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    iso.trim(),
  );
  if (!m || iso.trim() === 'P' || iso.trim().endsWith('T')) return undefined;
  const [, w, d, h, min, s] = m;
  return Math.round(
    Number(w ?? 0) * 7 * 86_400 +
      Number(d ?? 0) * 86_400 +
      Number(h ?? 0) * 3600 +
      Number(min ?? 0) * 60 +
      Number(s ?? 0),
  );
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

interface VideoView {
  id?: unknown;
  snippet?: {
    publishedAt?: unknown;
    channelId?: unknown;
    title?: unknown;
    description?: unknown;
    channelTitle?: unknown;
    tags?: unknown;
    liveBroadcastContent?: unknown;
    defaultAudioLanguage?: unknown;
    defaultLanguage?: unknown;
    thumbnails?: Record<string, { url?: unknown } | undefined>;
  };
  contentDetails?: { duration?: unknown; caption?: unknown };
  statistics?: { viewCount?: unknown; likeCount?: unknown; commentCount?: unknown };
  status?: { privacyStatus?: unknown };
}

function bestThumbnail(set: Record<string, { url?: unknown } | undefined> | undefined): string {
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = str(set?.[size]?.url);
    if (url) return url;
  }
  return '';
}

/** Map one `videos.list` resource (snippet, contentDetails, statistics, status) to a record. */
export function videoToRecord(item: unknown, opts: { metricsUpdatedAt: string }): NormalizedRecord {
  const video = (item ?? {}) as VideoView;
  const id = str(video.id);
  if (!id) throw new Error('YouTube video is missing its id.');
  const snippet = video.snippet ?? {};
  const title = str(snippet.title).trim() || '(untitled video)';
  const description = str(snippet.description).trim();
  const publishedAt = str(snippet.publishedAt);
  const channel = str(snippet.channelTitle);
  const iso = str(video.contentDetails?.duration);
  const seconds = iso ? isoDurationSeconds(iso) : undefined;
  const tags = Array.isArray(snippet.tags) ? snippet.tags.filter((t) => typeof t === 'string') : [];
  const live = str(snippet.liveBroadcastContent);
  const stats = video.statistics ?? {};
  const url = youtubeWatchUrl(id);
  return {
    recordId: `yt:${id}`,
    dirSegments: monthSegments(publishedAt),
    fileStem: postFileStem(publishedAt, title),
    frontmatter: orderedFrontmatter([
      ['title', title],
      ['date', publishedAt],
      ['platform', 'youtube'],
      ['channel', channel],
      ['channel_id', str(snippet.channelId)],
      ['video_id', id],
      ['url', url],
      // A live stream's duration is P0D until it ends.
      ['duration', seconds ? formatSeconds(seconds) : undefined],
      ['duration_iso', seconds ? iso : undefined],
      ['tags', tags.join(', ')],
      ['language', str(snippet.defaultAudioLanguage) || str(snippet.defaultLanguage)],
      ['privacy', str(video.status?.privacyStatus)],
      ['live', live && live !== 'none' ? live : undefined],
      ['has_captions', video.contentDetails?.caption === 'true' ? true : undefined],
      ['thumbnail', bestThumbnail(snippet.thumbnails)],
      ['views', countOf(stats.viewCount)],
      ['likes', countOf(stats.likeCount)],
      ['comments', countOf(stats.commentCount)],
      ['metrics_updated_at', video.statistics ? opts.metricsUpdatedAt : undefined],
      ['direction', 'inbound'],
    ]),
    bodyMarkdown: description || `Link: ${url}`,
    // The pass-time stamp alone is not a change worth rewriting the post for.
    volatileKeys: ['metrics_updated_at'],
    scanOrigin: YOUTUBE_TYPE_ID,
    quarantineNamespace: YOUTUBE_TYPE_ID,
    quarantineLabel: `YouTube video from ${channel || 'a channel'}`,
  };
}

/** The day's view/like/comment reading for one video (an engagement-history record). */
export function videoMetricsRecord(item: unknown, observedAt: string): NormalizedRecord {
  const video = (item ?? {}) as VideoView;
  const id = str(video.id);
  if (!id) throw new Error('YouTube video is missing its id.');
  const stats = video.statistics ?? {};
  return metricsHistoryRecord(
    {
      platform: 'youtube',
      postId: id,
      permalink: youtubeWatchUrl(id),
      title: firstLineTitle(str(video.snippet?.title)),
      observedAt,
      counts: [
        ['views', countOf(stats.viewCount)],
        ['likes', countOf(stats.likeCount)],
        ['comments', countOf(stats.commentCount)],
      ],
    },
    {
      scanOrigin: YOUTUBE_TYPE_ID,
      quarantineNamespace: YOUTUBE_TYPE_ID,
      quarantineLabel: 'YouTube engagement reading',
    },
  );
}

// ── the adapter ────────────────────────────────────────────────────────────

/** Test seam for the clock; production uses the wall clock. */
export interface YouTubeRuntime {
  now(): Date;
}

const defaultRuntime: YouTubeRuntime = { now: () => new Date() };

interface ChannelTarget {
  scope: string;
  spec?: ChannelSpec;
  refusal?: string;
}

interface PlaylistPage {
  items?: {
    contentDetails?: { videoId?: unknown };
    snippet?: { resourceId?: { videoId?: unknown } };
  }[];
  nextPageToken?: unknown;
}

export class YouTubeVideosAdapter implements ConnectorAdapter {
  readonly typeId = YOUTUBE_TYPE_ID;
  /** A scheduled premiere's publish time moves when it goes live. */
  readonly recordsMayMove = true;
  private config?: YouTubeConfig;
  private key = '';
  private syncedAt = '';
  private targets = new Map<string, ChannelTarget>();

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: YouTubeRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    if (this.config.channels.length === 0) {
      throw new Error(
        "This YouTube connector has no channels. Add a channel's @handle or UC… channel ID in the connector's settings.",
      );
    }
    const blob = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    this.key = readApiKey(blob);
    if (!this.key) {
      throw new Error(
        "No YouTube API key is stored for this connector. Add the API key credential in the connector's settings.",
      );
    }
    this.syncedAt = this.runtime.now().toISOString();
    this.targets = new Map();
    this.config.channels.forEach((raw, index) => {
      const spec = parseChannelSpec(raw);
      if ('error' in spec) {
        const scope = `invalid-channel-${index + 1}`;
        this.targets.set(scope, { scope, refusal: spec.error });
        return;
      }
      const scope = specScope(spec);
      if (!this.targets.has(scope)) this.targets.set(scope, { scope, spec });
    });
  }

  async listScopes(): Promise<string[]> {
    return [...this.targets.keys()];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    const target = this.targets.get(scope);
    if (!this.config || !target) return { records: [], cursor };
    // A refused or missing channel fails only its own scope; the engine keeps
    // syncing the others and names this one in the binding's status.
    if (target.refusal || !target.spec) {
      throw new YouTubeChannelUnavailableError(target.refusal ?? scope);
    }
    try {
      return await this.listChannel(target.spec, cursor, opts);
    } catch (err) {
      if (isThrottle(err)) return { records: [], cursor, rateLimited: true };
      throw err;
    }
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const raw = (ref.raw ?? {}) as { video?: unknown; history?: unknown };
    if (raw.history) return videoMetricsRecord(raw.video, this.syncedAt);
    return videoToRecord(raw.video, { metricsUpdatedAt: this.syncedAt });
  }

  async close(): Promise<void> {}

  private async listChannel(
    spec: ChannelSpec,
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<ChannelCursor>> {
    const config = this.config!;
    const prior = parseChannelCursor(cursorRaw);
    const now = this.runtime.now();
    // Budget gate: inside the interval no request is made at all.
    if (
      prior &&
      !prior.walk &&
      !windowRefreshDue(prior.lastFetchAt, config.syncIntervalHours, now)
    ) {
      return { records: [], cursor: cursorRaw as ChannelCursor };
    }
    const channel = prior ?? (await this.resolveChannel(spec));
    const limit = Math.max(1, opts?.limit ?? DEFAULT_LIMIT);
    const stop = new Set(prior?.seen ?? []);

    // 1. Walk the uploads playlist from the top (or the cut-short page)
    //    until a video the corpus already has.
    let walk = prior?.walk ?? { pageToken: '', listed: 0, top: [] as string[] };
    const fresh: string[] = [];
    let pageToken = walk.pageToken || undefined;
    let listed = walk.listed;
    const top = [...walk.top];
    let complete = false;
    let restarted = false;
    while (!complete && fresh.length < limit) {
      if (listed >= config.maxVideos) {
        complete = true;
        break;
      }
      // Never ask for more than the batch can take, so a walk cut short at
      // `limit` always ends on a page boundary its next token resumes from.
      const want = Math.min(PAGE_SIZE, limit - fresh.length, config.maxVideos - listed);
      let page: PlaylistPage;
      try {
        page = await this.getJson<PlaylistPage>('playlistItems', {
          part: 'contentDetails',
          playlistId: channel.uploads,
          maxResults: String(want),
          ...(pageToken ? { pageToken } : {}),
        });
      } catch (err) {
        // A stale page token (the resumed walk is old): start over from the
        // top. The writer dedupes what the earlier rounds already wrote.
        if (
          !restarted &&
          pageToken &&
          err instanceof YouTubeApiError &&
          err.reasons.includes('invalidPageToken')
        ) {
          restarted = true;
          pageToken = undefined;
          listed = 0;
          top.length = 0;
          fresh.length = 0;
          continue;
        }
        if (err instanceof YouTubeChannelUnavailableError) {
          throw new YouTubeChannelUnavailableError(
            `The uploads of ${channel.title || channel.channelId} could not be listed; the channel may have been removed.`,
          );
        }
        throw err;
      }
      for (const item of page.items ?? []) {
        const id = str(item.contentDetails?.videoId) || str(item.snippet?.resourceId?.videoId);
        if (!id) continue;
        if (stop.has(id) || listed >= config.maxVideos) {
          complete = true;
          break;
        }
        if (top.length < STOP_MARKERS) top.push(id);
        fresh.push(id);
        listed++;
      }
      if (complete) break;
      pageToken = str(page.nextPageToken) || undefined;
      if (!pageToken || listed >= config.maxVideos) complete = true;
    }
    walk = { pageToken: pageToken ?? '', listed, top };

    // 2. Refresh counts on watched videos once the walk is whole.
    const floorMs = now.getTime() - config.metricsWindowDays * DAY_MS;
    const metricsDue =
      complete &&
      prior?.seen !== undefined &&
      prior.seen.length > 0 &&
      config.metricsWindowDays > 0 &&
      windowRefreshDue(prior.metricsRefreshedAt, config.metricsRefreshHours, now);
    const refresh = metricsDue
      ? (prior?.watch ?? [])
          .filter(([id, ms]) => ms >= floorMs && !fresh.includes(id))
          .map(([id]) => id)
          .slice(0, Math.max(0, limit - fresh.length))
      : [];

    // 3. One videos.list call per 50 ids.
    const videos = await this.videosById([...fresh, ...refresh]);
    const refs: RecordRef[] = [];
    const observed: Watched[] = [];
    for (const id of [...fresh, ...refresh]) {
      const video = videos.get(id);
      // Absent: made private or deleted between the two calls.
      if (!video) continue;
      const publishedAt = str((video as VideoView).snippet?.publishedAt);
      const ms = Date.parse(publishedAt);
      if (Number.isFinite(ms)) observed.push([id, ms]);
      refs.push({
        id,
        raw: { video },
        ...(publishedAt ? { ts: publishedAt } : {}),
        ...(Number.isFinite(ms) ? { ordinalKey: ms } : {}),
      });
    }
    if (config.metricsHistory) {
      // History rows ride leftover room only, like x-posts: rows sorted in
      // ahead of videos past the engine's cap would cost those videos for good.
      const at = Date.parse(this.syncedAt);
      for (const ref of refs.slice(0, Math.max(0, limit - refs.length))) {
        refs.push({
          id: `metrics:${ref.id}`,
          raw: { video: (ref.raw as { video: unknown }).video, history: true },
          ts: this.syncedAt,
          ordinalKey: at,
        });
      }
    }

    const watch = mergeWatch(prior?.watch ?? [], observed, floorMs, config.metricsWindowDays);
    const base: ChannelCursor = {
      channelId: channel.channelId,
      uploads: channel.uploads,
      title: channel.title,
      watch,
    };
    if (!complete) {
      return {
        records: refs,
        cursor: {
          ...base,
          seen: prior?.seen ?? [],
          ...(prior?.lastFetchAt ? { lastFetchAt: prior.lastFetchAt } : {}),
          ...(prior?.metricsRefreshedAt ? { metricsRefreshedAt: prior.metricsRefreshedAt } : {}),
          walk,
        },
        partial: true,
      };
    }
    const seen = [...new Set([...top, ...(prior?.seen ?? [])])].slice(0, STOP_MARKERS);
    // The first walk observed counts on everything it fetched, so the refresh
    // window starts counting from it.
    const refreshedNow = metricsDue || !prior?.metricsRefreshedAt;
    return {
      records: refs,
      cursor: {
        ...base,
        seen,
        lastFetchAt: now.toISOString(),
        ...(refreshedNow
          ? { metricsRefreshedAt: now.toISOString() }
          : prior?.metricsRefreshedAt
            ? { metricsRefreshedAt: prior.metricsRefreshedAt }
            : {}),
      },
    };
  }

  /** `channels.list` once per binding lifetime; the result is pinned in the cursor. */
  private async resolveChannel(spec: ChannelSpec): Promise<ChannelCursor> {
    const filter: Record<string, string> =
      spec.kind === 'id'
        ? { id: spec.value }
        : spec.kind === 'handle'
          ? { forHandle: spec.value }
          : { forUsername: spec.value };
    const res = await this.getJson<{
      items?: {
        id?: unknown;
        snippet?: { title?: unknown };
        contentDetails?: { relatedPlaylists?: { uploads?: unknown } };
      }[];
    }>('channels', { part: 'snippet,contentDetails', ...filter });
    const item = res.items?.[0];
    const channelId = str(item?.id);
    if (!channelId) {
      const named = spec.kind === 'username' ? `the user name ${spec.value}` : spec.value;
      throw new YouTubeChannelUnavailableError(
        `YouTube has no channel for ${named}. Check the channel in the connector's settings.`,
      );
    }
    // Every channel's uploads playlist is its id with UC → UU; the
    // contentDetails value is preferred when present.
    const uploads =
      str(item?.contentDetails?.relatedPlaylists?.uploads) || `UU${channelId.slice(2)}`;
    return { channelId, uploads, title: str(item?.snippet?.title) };
  }

  private async videosById(ids: string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    for (let i = 0; i < ids.length; i += VIDEO_BATCH) {
      const batch = ids.slice(i, i + VIDEO_BATCH);
      // No maxResults: videos.list does not accept it alongside `id`.
      const res = await this.getJson<{ items?: { id?: unknown }[] }>('videos', {
        part: 'snippet,contentDetails,statistics,status',
        id: batch.join(','),
      });
      for (const video of res.items ?? []) {
        const id = str(video?.id);
        if (id) out.set(id, video);
      }
    }
    return out;
  }

  private async getJson<T>(resource: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${YOUTUBE_API_BASE}/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await (this.deps.fetch ?? fetch)(url.href, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': this.key, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw toApiError(res.status, text, resource, this.key);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error(`YouTube ${resource} returned a body that is not JSON.`);
    }
  }
}

function mergeWatch(
  prior: Watched[],
  seen: Watched[],
  floorMs: number,
  windowDays: number,
): Watched[] {
  if (windowDays <= 0) return [];
  const byId = new Map<string, number>();
  for (const [id, ms] of [...prior, ...seen]) byId.set(id, ms);
  return [...byId]
    .filter(([, ms]) => ms >= floorMs)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, WATCH_CAP);
}

/** The stored credential: the bare key the bind form saves, or a JSON blob naming it. */
function readApiKey(blob: string | null): string {
  const raw = blob?.trim() ?? '';
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const field of ['apiKey', 'key', 'token']) {
      if (typeof parsed[field] === 'string' && parsed[field])
        return (parsed[field] as string).trim();
    }
  } catch {
    /* not JSON after all: use as written */
  }
  return raw;
}

/** Register the YouTube native adapter (adapterId `youtube-videos`). */
export function registerYouTubeAdapters(): void {
  registerNativeAdapter(
    YOUTUBE_TYPE_ID,
    async (binding, deps) => new YouTubeVideosAdapter(binding, deps),
  );
}
