/**
 * X (Twitter) as a `native` connector adapter: the account's own posts, an
 * optional mentions feed, and a daily account-stats series, normalized into
 * the shared social corpus shape (month buckets, iso-minute stems, ordered
 * frontmatter). Raw `fetch` against api.x.com v2 through an injectable
 * runtime seam — no platform SDK, mirroring bluesky-posts.
 *
 * Reads are PAID on every X API tier (the free tier allows roughly 100 reads
 * per month), which shapes the whole adapter: every read scope is gated by an
 * interval cursor so the 90-second engine tick never translates into API
 * requests, mentions are off by default, the account id is resolved once and
 * pinned into the cursor, and the metrics re-walk is a single bounded page.
 *
 * Construct-per-pass like calendar-google: `ensureAuth` reads the binding's
 * OAuth blob, refreshes it when expired, and holds the access token for the
 * pass. X rotates the refresh token on every refresh, so the rotated blob is
 * re-persisted immediately — losing it strands the binding at the next
 * refresh.
 *
 * Publishing is real, unlike reads it fits the free tier: `POST /2/tweets`
 * rides the ~500 writes/month budget, so the `publish` action goes through
 * the consent-gated `social-publish` scope (off until the binding enables
 * `allowPublish`; every commit is individually consented). Each observed
 * post additionally leaves a per-(post, day) engagement-history record
 * (social-shared's `metricsHistoryRecord`) unless `metricsHistory` is off.
 */

import { isRateLimitStatus } from '@bendyline/gezel';
import {
  type OAuthEndpoints,
  type OAuthTokens,
  type RefreshTokenParams,
  isExpired,
  refreshToken,
} from '../oauth.js';
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

const API_BASE = 'https://api.x.com/2';
const X_ENDPOINTS: OAuthEndpoints = {
  authEndpoint: 'https://x.com/i/oauth2/authorize',
  tokenEndpoint: 'https://api.x.com/2/oauth2/token',
  scopes: [],
};
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PASS = 5;
const DEFAULT_BACKFILL = 500;
const TWEET_FIELDS = 'public_metrics,created_at,lang,entities,referenced_tweets,attachments';
/** X's advertised post ceiling; URLs are weighed as 23 chars on their side. */
const MAX_POST_CODEPOINTS = 280;

interface XConfig {
  syncMentions: boolean;
  syncIntervalHours: number;
  metricsWindowDays: number;
  metricsRefreshHours: number;
  statsIntervalHours: number;
  metricsHistory: boolean;
  allowPublish: boolean;
}

interface XOAuthCred {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
}

/** A non-2xx api.x.com response; `status` drives the rate-limit mapping. */
export class XApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`x api ${status}: ${detail}`.trim());
    this.name = 'XApiError';
  }
}

/** The slice of the outside world the adapter consumes (injectable for tests). */
export interface XRuntime {
  /** GET a v2 API URL with a bearer token; parsed JSON out; XApiError on !ok. */
  getJson(url: string, accessToken: string): Promise<unknown>;
  /** POST a JSON body to a v2 API URL with a bearer token; same error shape. */
  postJson(url: string, accessToken: string, body: unknown): Promise<unknown>;
  /** OAuth refresh through the shared connector OAuth core. */
  refreshToken(params: RefreshTokenParams): Promise<OAuthTokens>;
  now(): Date;
}

async function xApiJson(url: string, accessToken: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new XApiError(res.status, text.slice(0, 300));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

const defaultRuntime: XRuntime = {
  getJson: (url, accessToken) => xApiJson(url, accessToken),
  postJson: (url, accessToken, body) =>
    xApiJson(url, accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  refreshToken: (params) => refreshToken(params),
  now: () => new Date(),
};

interface PostsCursor {
  sinceId?: string;
  lastFetchAt?: string;
  metricsRefreshedAt?: string;
  userId?: string;
  username?: string;
}

interface MentionsCursor {
  sinceId?: string;
  lastFetchAt?: string;
  userId?: string;
  username?: string;
}

interface StatsCursor {
  lastFetchAt: string;
  lastDay: string;
}

export class XPostsAdapter implements ConnectorAdapter {
  readonly typeId = 'x-posts';
  private config?: XConfig;
  private token = '';
  /** One timestamp per pass so every refreshed post carries the same stamp. */
  private syncedAt = '';
  /** Per-pass memo of the signed-in account, seeded from cursors when cached. */
  private self?: { userId: string; username: string };

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: XRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const key = connectorSecretKey(this.binding.type, this.binding.id);
    const blob = await this.deps.secrets.get(key);
    if (!blob) {
      throw new Error(
        `No stored credential for X connector ${this.binding.id}. Re-link the account from the connector's settings.`,
      );
    }
    let cred = JSON.parse(blob) as XOAuthCred;
    if (!cred.accessToken) {
      throw new Error(
        `The stored X credential for ${this.binding.id} has no access token. Re-link the account.`,
      );
    }
    if (isExpired(cred)) {
      if (!cred.refreshToken || !cred.clientId) {
        throw new Error(
          'The X access token expired and no refresh token is stored. Re-link the account.',
        );
      }
      const t = await this.runtime.refreshToken({
        endpoints: X_ENDPOINTS,
        clientId: cred.clientId,
        ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
        refreshToken: cred.refreshToken,
      });
      // X rotates the refresh token on every refresh; failing to persist the
      // rotation strands the binding at the next refresh (invalid_grant).
      cred = {
        ...cred,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      };
      await this.deps.secrets.set(key, JSON.stringify(cred));
    }
    this.token = cred.accessToken;
    this.syncedAt = this.runtime.now().toISOString();
  }

  async listScopes(): Promise<string[]> {
    const config = this.assertReady();
    return ['posts', ...(config.syncMentions ? ['mentions'] : []), 'stats'];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    try {
      if (scope === 'posts') return await this.listPosts(cursor, opts);
      if (scope === 'mentions') return await this.listMentions(cursor, opts);
      if (scope === 'stats') return await this.listStats(cursor);
      return { records: [], cursor };
    } catch (err) {
      if (isRateLimitError(err)) return { records: [], cursor, rateLimited: true };
      throw err;
    }
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    this.assertReady();
    if (scope === 'posts') {
      const prebuilt = prebuiltMetricsRecord(ref.raw);
      if (prebuilt) return prebuilt;
      return tweetToRecord(ref.raw, {
        username: this.self?.username ?? '',
        metricsUpdatedAt: this.syncedAt,
      });
    }
    if (scope === 'mentions') {
      const raw = (ref.raw ?? {}) as { tweet?: unknown; author?: unknown };
      return mentionToRecord(raw.tweet, raw.author);
    }
    if (scope === 'stats') {
      const raw = (ref.raw ?? {}) as { profile?: unknown; day?: unknown };
      return profileToStatsRecord(raw.profile, typeof raw.day === 'string' ? raw.day : '');
    }
    throw new Error(`unknown x-posts scope '${scope}'`);
  }

  async runAction(action: string, input: unknown): Promise<unknown> {
    if (action !== 'publish') {
      throw new Error(`x-posts declares no action '${action}'`);
    }
    const config = this.assertReady();
    // The social-publish consent enforcer already gates the commit; this is
    // defense-in-depth for any future non-outbox caller.
    if (!config.allowPublish) {
      throw new Error(
        "Publishing is disabled on this X connector. Enable 'Allow publishing' in the connector's settings first.",
      );
    }
    const parsed = parsePublishInput(input);
    const length = [...parsed.text].length;
    if (length > MAX_POST_CODEPOINTS) {
      throw new Error(
        `X posts are limited to ${MAX_POST_CODEPOINTS} characters; this draft is ${length}. X weighs every URL as 23 characters regardless of its length, so its own count may differ slightly. Shorten the text and draft again.`,
      );
    }
    const res = (await this.runtime.postJson(`${API_BASE}/tweets`, this.token, {
      text: parsed.text,
      ...(parsed.replyToId ? { reply: { in_reply_to_tweet_id: parsed.replyToId } } : {}),
    })) as { data?: { id?: unknown } };
    const id = typeof res.data?.id === 'string' ? res.data.id : '';
    if (!id) {
      throw new Error('X returned no post id; the publish may not have gone through.');
    }
    // The account-agnostic /i/ permalink avoids spending a paid read on
    // /2/users/me just to decorate the receipt; the memoized username is
    // used when a pass already resolved it.
    return { id, permalink: xPermalink(this.self?.username ?? '', id) };
  }

  async close(): Promise<void> {}

  private assertReady(): XConfig {
    if (!this.config || !this.token) {
      throw new Error('X connector has not been initialized.');
    }
    return this.config;
  }

  /**
   * The signed-in account's id + username. `GET /2/users/me` is a paid read,
   * so the result is pinned into every scope cursor and later passes seed the
   * memo from there without touching the API.
   */
  private async resolveSelf(cached?: {
    userId?: string;
    username?: string;
  }): Promise<{ userId: string; username: string }> {
    if (!this.self && cached?.userId && cached.username) {
      this.self = { userId: cached.userId, username: cached.username };
    }
    if (!this.self) {
      const res = (await this.runtime.getJson(`${API_BASE}/users/me`, this.token)) as {
        data?: { id?: unknown; username?: unknown };
      };
      const userId = typeof res.data?.id === 'string' ? res.data.id : '';
      const username = typeof res.data?.username === 'string' ? res.data.username : '';
      if (!userId || !username) {
        throw new Error('X /2/users/me returned no account id; cannot sync this binding.');
      }
      this.self = { userId, username };
    }
    return this.self;
  }

  private async timelinePage(
    path: string,
    params: Record<string, string>,
  ): Promise<{
    items: unknown[];
    users: Map<string, { id: string; username: string }>;
    nextToken?: string;
  }> {
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set('max_results', String(PAGE_SIZE));
    url.searchParams.set('tweet.fields', TWEET_FIELDS);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = (await this.runtime.getJson(url.toString(), this.token)) as {
      data?: unknown[];
      includes?: { users?: unknown[] };
      meta?: { next_token?: unknown };
    };
    const users = new Map<string, { id: string; username: string }>();
    for (const user of res.includes?.users ?? []) {
      const view = (user ?? null) as { id?: unknown; username?: unknown } | null;
      if (typeof view?.id === 'string' && typeof view.username === 'string') {
        users.set(view.id, { id: view.id, username: view.username });
      }
    }
    return {
      items: Array.isArray(res.data) ? res.data : [],
      users,
      ...(typeof res.meta?.next_token === 'string' && res.meta.next_token
        ? { nextToken: res.meta.next_token }
        : {}),
    };
  }

  private async listPosts(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<PostsCursor>> {
    const config = this.assertReady();
    const prior = parsePostsCursor(cursorRaw);
    const now = this.runtime.now();
    // Budget gate: every pass costs paid reads, so inside the interval the
    // batch is empty, the cursor untouched, and zero requests are made.
    if (prior && !windowRefreshDue(prior.lastFetchAt, config.syncIntervalHours, now)) {
      return { records: [], cursor: prior };
    }
    const self = await this.resolveSelf(prior);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);
    const metricsDue =
      prior?.sinceId !== undefined &&
      windowRefreshDue(prior.metricsRefreshedAt, config.metricsRefreshHours, now);

    const byId = new Map<string, RecordRef>();
    let maxId = prior?.sinceId;

    // Incremental: everything newer than since_id, newest-first, paged.
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_PASS && byId.size < limit; page++) {
      const res = await this.timelinePage(`/users/${encodeURIComponent(self.userId)}/tweets`, {
        ...(prior?.sinceId ? { since_id: prior.sinceId } : {}),
        ...(pageToken ? { pagination_token: pageToken } : {}),
      });
      for (const item of res.items) {
        const scan = scanTweet(item);
        if (!scan) continue;
        maxId = maxTweetId(maxId, scan.id);
        if (byId.size >= limit) break;
        byId.set(scan.id, {
          id: scan.id,
          raw: item,
          ts: scan.createdAtIso,
          ordinalKey: scan.createdAtMs,
        });
      }
      pageToken = res.nextToken;
      if (!pageToken || res.items.length === 0) break;
    }

    // Metrics re-walk: ONE page bounded by the window re-observes engagement
    // counts on recent posts, merged by id so refreshed items replace stale
    // raw. A single request keeps the paid-read cost of a refresh constant.
    if (metricsDue) {
      const windowFloor = new Date(
        now.getTime() - config.metricsWindowDays * 86_400_000,
      ).toISOString();
      const res = await this.timelinePage(`/users/${encodeURIComponent(self.userId)}/tweets`, {
        start_time: windowFloor,
      });
      for (const item of res.items) {
        const scan = scanTweet(item);
        if (!scan) continue;
        maxId = maxTweetId(maxId, scan.id);
        if (byId.size >= limit && !byId.has(scan.id)) continue;
        byId.set(scan.id, {
          id: scan.id,
          raw: item,
          ts: scan.createdAtIso,
          ordinalKey: scan.createdAtMs,
        });
      }
    }

    const cursor: PostsCursor = {
      ...(maxId ? { sinceId: maxId } : {}),
      lastFetchAt: now.toISOString(),
      // The first pass is one bounded backfill; it observes metrics for
      // everything it fetches, so the refresh window starts counting from it.
      ...(metricsDue || prior?.sinceId === undefined
        ? { metricsRefreshedAt: now.toISOString() }
        : prior.metricsRefreshedAt
          ? { metricsRefreshedAt: prior.metricsRefreshedAt }
          : {}),
      userId: self.userId,
      username: self.username,
    };
    const posts = [...byId.values()];
    const records = config.metricsHistory
      ? [...posts, ...this.metricsHistoryRefs(posts, self.username, limit - posts.length)]
      : posts;
    return { records, cursor };
  }

  /**
   * One prebuilt engagement-history record per observed post, riding the same
   * batch (fetchRecord passes them through untouched). Budgeted to the pass's
   * leftover headroom under `limit`: the engine slices every batch newest-first
   * at its backfill cap, and history rows (ordinal = now) would displace real
   * posts past it — the cursor still advances, so displaced posts would never
   * be fetched again. On a cap-sized backfill the counts already live on the
   * post records; the history series just starts one pass later.
   */
  private metricsHistoryRefs(posts: RecordRef[], username: string, room: number): RecordRef[] {
    if (room <= 0) return [];
    const observedAt = this.syncedAt;
    const ordinalKey = Date.parse(observedAt);
    return [...posts]
      .sort((a, b) => (b.ordinalKey ?? 0) - (a.ordinalKey ?? 0))
      .slice(0, room)
      .map((post) => {
        const record = tweetMetricsRecord(post.raw, { username, observedAt });
        return { id: record.recordId, raw: { metricsHistory: record }, ts: observedAt, ordinalKey };
      });
  }

  private async listMentions(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<MentionsCursor>> {
    const config = this.assertReady();
    const prior = parseMentionsCursor(cursorRaw);
    const now = this.runtime.now();
    // Mentions reads ride the same paid meter as posts; same budget gate.
    if (prior && !windowRefreshDue(prior.lastFetchAt, config.syncIntervalHours, now)) {
      return { records: [], cursor: prior };
    }
    const self = await this.resolveSelf(prior);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);

    const records: RecordRef[] = [];
    const seen = new Set<string>();
    let maxId = prior?.sinceId;
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES_PER_PASS && records.length < limit; page++) {
      const res = await this.timelinePage(`/users/${encodeURIComponent(self.userId)}/mentions`, {
        expansions: 'author_id',
        'user.fields': 'username',
        ...(prior?.sinceId ? { since_id: prior.sinceId } : {}),
        ...(pageToken ? { pagination_token: pageToken } : {}),
      });
      for (const item of res.items) {
        const scan = scanTweet(item);
        if (!scan) continue;
        maxId = maxTweetId(maxId, scan.id);
        if (seen.has(scan.id) || records.length >= limit) continue;
        seen.add(scan.id);
        const authorId = (item as { author_id?: unknown }).author_id;
        const author = typeof authorId === 'string' ? res.users.get(authorId) : undefined;
        records.push({
          id: scan.id,
          raw: { tweet: item, ...(author ? { author } : {}) },
          ts: scan.createdAtIso,
          ordinalKey: scan.createdAtMs,
        });
      }
      pageToken = res.nextToken;
      if (!pageToken || res.items.length === 0) break;
    }

    const cursor: MentionsCursor = {
      ...(maxId ? { sinceId: maxId } : {}),
      lastFetchAt: now.toISOString(),
      userId: self.userId,
      username: self.username,
    };
    return { records, cursor };
  }

  private async listStats(cursorRaw: unknown): Promise<ChangeBatch<StatsCursor>> {
    const config = this.assertReady();
    const prior = parseStatsCursor(cursorRaw);
    const now = this.runtime.now();
    if (prior && !windowRefreshDue(prior.lastFetchAt, config.statsIntervalHours, now)) {
      return { records: [], cursor: prior };
    }
    const url = new URL(`${API_BASE}/users/me`);
    url.searchParams.set('user.fields', 'public_metrics');
    const res = (await this.runtime.getJson(url.toString(), this.token)) as {
      data?: { id?: unknown; username?: unknown };
    };
    const profile = res.data ?? {};
    // The stats read returns the whole user object — seed the per-pass memo
    // so a stats-first pass saves the posts scope its /users/me read.
    if (
      !this.self &&
      typeof profile.id === 'string' &&
      profile.id &&
      typeof profile.username === 'string' &&
      profile.username
    ) {
      this.self = { userId: profile.id, username: profile.username };
    }
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

function parseConfig(raw: Record<string, unknown> | undefined): XConfig {
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  return {
    // Off by default: mentions cost extra paid reads every interval.
    syncMentions: raw?.syncMentions === true,
    syncIntervalHours: num(raw?.syncIntervalHours, 4, 0.25, 24 * 30),
    metricsWindowDays: num(raw?.metricsWindowDays, 7, 1, 365),
    metricsRefreshHours: num(raw?.metricsRefreshHours, 24, 0.25, 24 * 30),
    statsIntervalHours: num(raw?.statsIntervalHours, 6, 0.25, 24 * 30),
    metricsHistory: raw?.metricsHistory !== false,
    allowPublish: raw?.allowPublish === true,
  };
}

interface PublishInput {
  text: string;
  replyToId?: string;
}

function parsePublishInput(input: unknown): PublishInput {
  if (!input || typeof input !== 'object') {
    throw new Error('publish input must be an object with a text field');
  }
  const value = input as Record<string, unknown>;
  const text = typeof value.text === 'string' ? value.text : '';
  if (!text.trim()) throw new Error('publish requires non-empty post text');
  const replyToId =
    typeof value.replyToId === 'string' && value.replyToId.trim()
      ? value.replyToId.trim()
      : undefined;
  return { text, ...(replyToId ? { replyToId } : {}) };
}

function parsePostsCursor(raw: unknown): PostsCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key] ? (value[key] as string) : undefined;
  const sinceId = pick('sinceId');
  const lastFetchAt = pick('lastFetchAt');
  const metricsRefreshedAt = pick('metricsRefreshedAt');
  const userId = pick('userId');
  const username = pick('username');
  if (!sinceId && !lastFetchAt && !metricsRefreshedAt && !userId) return undefined;
  return {
    ...(sinceId ? { sinceId } : {}),
    ...(lastFetchAt ? { lastFetchAt } : {}),
    ...(metricsRefreshedAt ? { metricsRefreshedAt } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
  };
}

function parseMentionsCursor(raw: unknown): MentionsCursor | undefined {
  const parsed = parsePostsCursor(raw);
  if (!parsed) return undefined;
  const { metricsRefreshedAt: _drop, ...rest } = parsed;
  return rest;
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

/**
 * 429 is X's throttle; the monthly usage cap additionally surfaces as a 403
 * whose body names the cap. Both mean "back off", not "the pass failed".
 */
function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return false;
  if (isRateLimitStatus(status)) return true;
  if (status !== 403) return false;
  const detail = err instanceof Error ? err.message : '';
  return /usage ?cap|rate ?limit/i.test(detail);
}

interface TweetScan {
  id: string;
  createdAtIso: string;
  createdAtMs: number;
}

function scanTweet(item: unknown): TweetScan | null {
  if (!item || typeof item !== 'object') return null;
  const view = item as { id?: unknown; created_at?: unknown };
  const id = typeof view.id === 'string' ? view.id : '';
  const createdAtIso = typeof view.created_at === 'string' ? view.created_at : '';
  const createdAtMs = tsMs(createdAtIso);
  if (!id || createdAtMs === undefined) return null;
  return { id, createdAtIso, createdAtMs };
}

/** Tweet ids are int64 strings; numeric-string comparison needs BigInt. */
function maxTweetId(a: string | undefined, b: string): string {
  if (!a) return b;
  try {
    return BigInt(b) > BigInt(a) ? b : a;
  } catch {
    return a;
  }
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

/** `https://x.com/<username>/status/<id>`; `i` is X's account-agnostic namespace. */
export function xPermalink(username: string, tweetId: string): string {
  return `https://x.com/${username || 'i'}/status/${tweetId}`;
}

/** The `replied_to` referenced tweet id, when the tweet is a reply. */
function repliedToId(referenced: unknown): string {
  if (!Array.isArray(referenced)) return '';
  for (const ref of referenced) {
    const view = (ref ?? null) as { type?: unknown; id?: unknown } | null;
    if (view?.type === 'replied_to' && typeof view.id === 'string') return view.id;
  }
  return '';
}

/** Replace t.co wrappers with their expanded targets so the corpus is readable. */
function expandUrls(text: string, entities: unknown): string {
  const urls = (entities as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls)) return text;
  let out = text;
  for (const entry of urls) {
    const view = (entry ?? null) as { url?: unknown; expanded_url?: unknown } | null;
    const short = typeof view?.url === 'string' ? view.url : '';
    const expanded = typeof view?.expanded_url === 'string' ? view.expanded_url : '';
    if (short && expanded) out = out.split(short).join(expanded);
  }
  return out;
}

interface TweetView {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  lang?: unknown;
  entities?: unknown;
  referenced_tweets?: unknown;
  attachments?: { media_keys?: unknown };
  public_metrics?: {
    like_count?: unknown;
    retweet_count?: unknown;
    reply_count?: unknown;
    quote_count?: unknown;
    bookmark_count?: unknown;
    impression_count?: unknown;
  };
}

export interface TweetRecordOptions {
  /** The signed-in account's username (author + permalink). */
  username: string;
  /** ISO timestamp of this sync pass — when the counts were observed. */
  metricsUpdatedAt: string;
}

/** Map one v2 tweet object (`users/:id/tweets` item) to a corpus record. */
export function tweetToRecord(item: unknown, opts: TweetRecordOptions): NormalizedRecord {
  const tweet = (item ?? {}) as TweetView;
  const id = str(tweet.id);
  if (!id) throw new Error('X tweet is missing its id.');
  const text = expandUrls(str(tweet.text), tweet.entities);
  const createdAt = str(tweet.created_at);
  const metrics = tweet.public_metrics ?? {};
  const inReplyTo = repliedToId(tweet.referenced_tweets);
  const hasMedia =
    Array.isArray(tweet.attachments?.media_keys) && tweet.attachments.media_keys.length > 0;
  const username = opts.username;

  const frontmatter = orderedFrontmatter([
    ['title', firstLineTitle(text) || '(no text)'],
    ['date', createdAt],
    ['platform', 'x'],
    ['author', username || undefined],
    ['tweet_id', id],
    ['permalink', xPermalink(username, id)],
    ['in_reply_to', inReplyTo || undefined],
    ['likes', count(metrics.like_count)],
    ['reposts', count(metrics.retweet_count)],
    ['replies', count(metrics.reply_count)],
    ['quotes', count(metrics.quote_count)],
    ['bookmarks', count(metrics.bookmark_count)],
    ['views', count(metrics.impression_count)],
    ['lang', str(tweet.lang) || undefined],
    ['has_media', hasMedia],
    ['metrics_updated_at', opts.metricsUpdatedAt],
  ]);

  return {
    recordId: id,
    dirSegments: monthSegments(createdAt),
    fileStem: postFileStem(createdAt, text),
    frontmatter,
    bodyMarkdown: text,
    scanOrigin: 'x-posts',
    quarantineNamespace: 'x-posts',
    quarantineLabel: `X post by @${username || 'unknown'}`,
  };
}

/** Map one v2 tweet object to the day's engagement-history observation. */
export function tweetMetricsRecord(
  item: unknown,
  opts: { username: string; observedAt: string },
): NormalizedRecord {
  const tweet = (item ?? {}) as TweetView;
  const id = str(tweet.id);
  if (!id) throw new Error('X tweet is missing its id.');
  const text = expandUrls(str(tweet.text), tweet.entities);
  const metrics = tweet.public_metrics ?? {};
  return metricsHistoryRecord(
    {
      platform: 'x',
      postId: id,
      permalink: xPermalink(opts.username, id),
      title: firstLineTitle(text),
      observedAt: opts.observedAt,
      counts: [
        ['likes', numeric(metrics.like_count)],
        ['reposts', numeric(metrics.retweet_count)],
        ['replies', numeric(metrics.reply_count)],
        ['quotes', numeric(metrics.quote_count)],
        ['bookmarks', numeric(metrics.bookmark_count)],
        ['views', numeric(metrics.impression_count)],
      ],
    },
    { scanOrigin: 'x-posts', quarantineNamespace: 'x-posts', quarantineLabel: 'Metrics reading' },
  );
}

/** Map one mentions-timeline tweet + its expanded author to a record. */
export function mentionToRecord(item: unknown, author: unknown): NormalizedRecord {
  const tweet = (item ?? {}) as TweetView;
  const id = str(tweet.id);
  if (!id) throw new Error('X mention is missing its id.');
  const username = str((author as { username?: unknown } | null)?.username) || 'unknown';
  const text = expandUrls(str(tweet.text), tweet.entities);
  const createdAt = str(tweet.created_at);
  const inReplyTo = repliedToId(tweet.referenced_tweets);
  const title = `mention from ${username}`;

  const frontmatter = orderedFrontmatter([
    ['title', title],
    ['date', createdAt],
    ['platform', 'x'],
    ['author', username],
    ['tweet_id', id],
    ['permalink', xPermalink(username === 'unknown' ? '' : username, id)],
    ['in_reply_to', inReplyTo || undefined],
    ['lang', str(tweet.lang) || undefined],
  ]);

  return {
    recordId: id,
    dirSegments: monthSegments(createdAt),
    fileStem: postFileStem(createdAt, title),
    frontmatter,
    bodyMarkdown: text,
    scanOrigin: 'x-posts',
    quarantineNamespace: 'x-posts',
    quarantineLabel: `X mention from @${username}`,
  };
}

/** Map one `users/me?user.fields=public_metrics` payload to the day's stats. */
export function profileToStatsRecord(profile: unknown, day: string): NormalizedRecord {
  const view = (profile ?? {}) as {
    username?: unknown;
    public_metrics?: {
      followers_count?: unknown;
      following_count?: unknown;
      tweet_count?: unknown;
    };
  };
  const username = str(view.username);
  const metrics = view.public_metrics ?? {};
  const followers = count(metrics.followers_count);
  const following = count(metrics.following_count);
  const postsCount = count(metrics.tweet_count);

  const frontmatter = orderedFrontmatter([
    ['title', `Account stats ${day}`],
    ['date', day],
    ['platform', 'x'],
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
    scanOrigin: 'x-posts',
    quarantineNamespace: 'x-posts',
    quarantineLabel: `X account stats for @${username || 'account'}`,
  };
}

/** Register the X native adapter. */
export function registerXAdapters(): void {
  registerNativeAdapter('x-posts', async (binding, deps) =>
    Promise.resolve(new XPostsAdapter(binding, deps)),
  );
}
