/**
 * X (Twitter) as a `native` connector adapter: the account's own posts, an
 * optional mentions feed, and a daily account-stats series, normalized into
 * the shared social corpus shape (month buckets, iso-minute stems, ordered
 * frontmatter). Raw `fetch` against api.x.com v2 through an injectable
 * runtime seam — no platform SDK, mirroring bluesky-posts. The default
 * runtime rides `AdapterDeps.fetch`, so the provider simulator drives it end
 * to end.
 *
 * Reads are PAID: X API access is pay-per-use, billed per resource returned
 * (reading the account's own timeline and mentions is the cheap "owned
 * reads" rate; `/2/users/me` is a user read). That shapes the adapter: every
 * read scope is gated by an interval cursor so the engine's ticks never turn
 * into requests, mentions are off by default, the account id is resolved once
 * and pinned into the cursor, and the metrics re-walk is a single bounded
 * page. A walk that outgrows one engine round continues through `until_id`
 * (`partial: true`) instead of jumping its high-water mark past posts it
 * never fetched.
 *
 * Construct-per-pass like calendar-google: `ensureAuth` reads the binding's
 * OAuth blob, refreshes it when expired, and holds the access token for the
 * pass. X rotates the refresh token on every refresh, so the rotated blob is
 * re-persisted immediately — losing it strands the binding at the next
 * refresh. A 401 on a token that looked valid gets one forced refresh.
 *
 * Edits and deletions: an edited post is a new post id upstream, so records
 * key on the ORIGINAL id (`edit_history_tweet_ids[0]`) and refresh in place.
 * A post deleted inside the metrics window is noticed by the next metrics
 * page (social-shared's deletion watch) and leaves the corpus along with its
 * engagement readings.
 *
 * Publishing goes through the consent-gated `social-publish` scope (off
 * until the binding enables `allowPublish`; every commit is individually
 * consented). Each observed post additionally leaves a per-(post, day)
 * engagement-history record (social-shared's `metricsHistoryRecord`) unless
 * `metricsHistory` is off.
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
import { ReconnectRequiredError } from './oauth-session.js';
import {
  type WatchedPost,
  deletedPostRecordIds,
  firstLineTitle,
  mergeWatchedPosts,
  metricsHistoryRecord,
  monthSegments,
  orderedFrontmatter,
  parseWatchedPosts,
  postFileStem,
  vanishedPosts,
  windowRefreshDue,
} from './social-shared.js';

const API_BASE = 'https://api.x.com/2';
const X_ENDPOINTS: OAuthEndpoints = {
  authEndpoint: 'https://x.com/i/oauth2/authorize',
  tokenEndpoint: 'https://api.x.com/2/oauth2/token',
  scopes: [],
};
/** `max_results` bounds on the timeline endpoints. */
const MIN_PAGE_SIZE = 5;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PASS = 5;
const DEFAULT_BACKFILL = 500;
const TWEET_FIELDS =
  'public_metrics,created_at,lang,entities,referenced_tweets,attachments,edit_history_tweet_ids';
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

async function xApiJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetchImpl(url, {
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

/** The production runtime over a transport (`AdapterDeps.fetch`, else global fetch). */
export function createXRuntime(fetchImpl: typeof fetch = fetch): XRuntime {
  return {
    getJson: (url, accessToken) => xApiJson(fetchImpl, url, accessToken),
    postJson: (url, accessToken, body) =>
      xApiJson(fetchImpl, url, accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    refreshToken: (params) => refreshToken({ ...params, fetchImpl }),
    now: () => new Date(),
  };
}

/**
 * A timeline walk left mid-way because it outgrew one engine round. The next
 * round resumes strictly below `untilId` and keeps `floorId` as `since_id`, so
 * the posts between the old high-water mark and the newest one are all
 * fetched before `sinceId` moves.
 */
interface TimelineWalk {
  floorId?: string;
  untilId: string;
  newestId?: string;
}

interface PostsCursor {
  sinceId?: string;
  lastFetchAt?: string;
  metricsRefreshedAt?: string;
  userId?: string;
  username?: string;
  /** Deletion watch: posts inside the metrics window (social-shared). */
  recent?: WatchedPost[];
  walk?: TimelineWalk;
}

interface MentionsCursor {
  sinceId?: string;
  lastFetchAt?: string;
  userId?: string;
  username?: string;
  walk?: TimelineWalk;
}

interface StatsCursor {
  lastFetchAt: string;
  lastDay: string;
}

interface ScannedTweet {
  item: unknown;
  scan: TweetScan;
}

interface WalkResult {
  items: ScannedTweet[];
  users: Map<string, { id: string; username: string }>;
  newestId?: string;
  /** The oldest id consumed — where a continuation resumes below. */
  untilId?: string;
  /** The walk reached the end of what the endpoint returns for its range. */
  done: boolean;
}

export class XPostsAdapter implements ConnectorAdapter {
  readonly typeId = 'x-posts';
  /** An edit can move a post's date into another month bucket. */
  readonly recordsMayMove = true;
  private readonly runtime: XRuntime;
  private config?: XConfig;
  private cred?: XOAuthCred;
  private token = '';
  /** One timestamp per pass so every refreshed post carries the same stamp. */
  private syncedAt = '';
  /** Per-pass memo of the signed-in account, seeded from cursors when cached. */
  private self?: { userId: string; username: string };
  /** An account-wide failure met earlier in this pass. */
  private accountFailure?: Error;

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    runtime?: XRuntime,
  ) {
    this.runtime = runtime ?? createXRuntime(deps.fetch);
  }

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const blob = await this.deps.secrets.get(this.secretKey());
    if (!blob) {
      throw new Error(
        `No stored credential for X connector ${this.binding.id}. Re-link the account from the connector's settings.`,
      );
    }
    let cred: XOAuthCred;
    try {
      cred = JSON.parse(blob) as XOAuthCred;
    } catch {
      throw new Error(
        `The stored X credential for ${this.binding.id} is unreadable. Re-link the account.`,
      );
    }
    if (!cred.accessToken) {
      throw new Error(
        `The stored X credential for ${this.binding.id} has no access token. Re-link the account.`,
      );
    }
    this.cred = cred;
    if (isExpired(cred)) {
      if (!cred.refreshToken || !cred.clientId) {
        throw new Error(
          'The X access token expired and no refresh token is stored. Re-link the account.',
        );
      }
      await this.refresh();
    }
    this.token = this.cred.accessToken;
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
    // A dead grant or a spent budget is the account's, not one scope's: the
    // rest of the pass fails with it rather than reporting the scopes whose
    // interval gate kept them from asking as synced.
    if (this.accountFailure) throw this.accountFailure;
    try {
      if (scope === 'posts') return await this.listPosts(cursor, opts);
      if (scope === 'mentions') return await this.listMentions(cursor, opts);
      if (scope === 'stats') return await this.listStats(cursor);
      return { records: [], cursor };
    } catch (err) {
      if (isBudgetExhausted(err)) {
        this.accountFailure = budgetExhaustedError();
        throw this.accountFailure;
      }
      if (err instanceof ReconnectRequiredError) {
        this.accountFailure = err;
        throw err;
      }
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
    let res: { data?: { id?: unknown } };
    try {
      res = (await this.api((token) =>
        this.runtime.postJson(`${API_BASE}/tweets`, token, {
          text: parsed.text,
          ...(parsed.replyToId ? { reply: { in_reply_to_tweet_id: parsed.replyToId } } : {}),
        }),
      )) as { data?: { id?: unknown } };
    } catch (err) {
      if (isBudgetExhausted(err)) throw budgetExhaustedError();
      if (isRateLimitError(err)) {
        throw new Error(
          'X rate-limited this publish. The draft is unchanged — wait a while and commit it again.',
        );
      }
      throw err;
    }
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

  private secretKey() {
    return connectorSecretKey(this.binding.type, this.binding.id);
  }

  /**
   * Refresh and re-persist. X rotates the refresh token on every refresh;
   * failing to persist the rotation strands the binding at the next refresh
   * (invalid_request), so the blob is written before the pass continues.
   */
  private async refresh(): Promise<void> {
    const cred = this.cred;
    if (!cred?.refreshToken || !cred.clientId) throw reconnectError();
    let t: OAuthTokens;
    try {
      t = await this.runtime.refreshToken({
        endpoints: X_ENDPOINTS,
        clientId: cred.clientId,
        ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
        refreshToken: cred.refreshToken,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // X answers a spent or revoked refresh token with invalid_request
      // ("Value passed for the token was invalid"), not invalid_grant.
      if (
        /invalid_grant|invalid_request|invalid|revoked|expired|unauthorized_client/i.test(detail)
      ) {
        throw reconnectError(detail);
      }
      throw err;
    }
    this.cred = {
      ...cred,
      accessToken: t.accessToken,
      expiresAt: t.expiresAt,
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    };
    await this.deps.secrets.set(this.secretKey(), JSON.stringify(this.cred));
    this.token = this.cred.accessToken;
  }

  /** One API call with a single forced refresh when a live-looking token gets a 401. */
  private async api<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(this.token);
    } catch (err) {
      if (!isUnauthorized(err)) throw err;
    }
    await this.refresh();
    try {
      return await call(this.token);
    } catch (err) {
      if (isUnauthorized(err)) throw reconnectError();
      throw err;
    }
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
      const res = (await this.api((token) =>
        this.runtime.getJson(`${API_BASE}/users/me`, token),
      )) as {
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
    maxResults = PAGE_SIZE,
  ): Promise<{
    items: unknown[];
    users: Map<string, { id: string; username: string }>;
    nextToken?: string;
  }> {
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set('max_results', String(maxResults));
    url.searchParams.set('tweet.fields', TWEET_FIELDS);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = (await this.api((token) => this.runtime.getJson(url.toString(), token))) as {
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

  /**
   * Walk a timeline newest-first above `floorId` (since_id), at most `limit`
   * posts and MAX_PAGES_PER_PASS pages. Paging uses `until_id` (the oldest id
   * consumed) rather than `pagination_token`, so a walk stopped mid-page
   * resumes exactly after the last post it returned and never needs a token
   * that could expire between rounds.
   */
  private async walkTimeline(
    path: string,
    opts: {
      floorId?: string;
      untilId?: string;
      newestId?: string;
      limit: number;
      params?: Record<string, string>;
    },
  ): Promise<WalkResult> {
    const items: ScannedTweet[] = [];
    const users = new Map<string, { id: string; username: string }>();
    let untilId = opts.untilId;
    let newestId = opts.newestId;
    let done = false;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      const remaining = opts.limit - items.length;
      if (remaining <= 0) break;
      const res = await this.timelinePage(
        path,
        {
          ...(opts.params ?? {}),
          ...(opts.floorId ? { since_id: opts.floorId } : {}),
          ...(untilId ? { until_id: untilId } : {}),
        },
        // Below X's minimum page size the overshoot is simply not consumed;
        // the next round resumes below the last post returned.
        Math.min(PAGE_SIZE, Math.max(MIN_PAGE_SIZE, remaining)),
      );
      for (const [id, user] of res.users) users.set(id, user);
      let consumedPage = true;
      for (const item of res.items) {
        const scan = scanTweet(item);
        if (!scan) continue;
        if (items.length >= opts.limit) {
          consumedPage = false;
          break;
        }
        items.push({ item, scan });
        newestId = maxTweetId(newestId, scan.id);
        untilId = minTweetId(untilId, scan.id);
      }
      if (!consumedPage) break;
      if (!res.nextToken || res.items.length === 0) {
        done = true;
        break;
      }
    }
    return {
      items,
      users,
      ...(newestId ? { newestId } : {}),
      ...(untilId ? { untilId } : {}),
      done,
    };
  }

  private async listPosts(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<PostsCursor>> {
    const config = this.assertReady();
    const prior = parsePostsCursor(cursorRaw);
    const now = this.runtime.now();
    // Budget gate: inside the interval the batch is empty, the cursor
    // untouched, and zero requests are made. A walk the previous round left
    // unfinished is exempt — its reads were already within the budget.
    if (
      prior &&
      !prior.walk &&
      !windowRefreshDue(prior.lastFetchAt, config.syncIntervalHours, now)
    ) {
      return { records: [], cursor: prior };
    }
    const self = await this.resolveSelf(prior);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);
    const path = `/users/${encodeURIComponent(self.userId)}/tweets`;
    // The first sync is one window of the newest `limit` posts; older history
    // is deliberately not backfilled (the manifest says so).
    const firstPass = !prior?.sinceId && !prior?.walk;
    const floorId = prior?.walk ? prior.walk.floorId : prior?.sinceId;
    const newest = prior?.walk?.newestId ?? prior?.sinceId;
    const walk = await this.walkTimeline(path, {
      ...(floorId ? { floorId } : {}),
      ...(prior?.walk ? { untilId: prior.walk.untilId } : {}),
      ...(newest ? { newestId: newest } : {}),
      limit,
    });

    const byId = new Map<string, RecordRef>();
    const seen: WatchedPost[] = [];
    for (const { item, scan } of walk.items) {
      keepNewestVersion(byId, scan, item);
      seen.push([scan.stableId, scan.createdAtMs]);
    }
    const windowFloorMs = now.getTime() - config.metricsWindowDays * 86_400_000;
    let recent = mergeWatchedPosts(prior?.recent ?? [], seen, windowFloorMs);
    const pinned = { userId: self.userId, username: self.username };

    if (!walk.done && !firstPass && walk.untilId) {
      // More posts above the old high-water mark than this round could take:
      // keep the mark where it was and resume below the oldest one returned.
      const cursor: PostsCursor = {
        ...(prior?.sinceId ? { sinceId: prior.sinceId } : {}),
        ...(prior?.lastFetchAt ? { lastFetchAt: prior.lastFetchAt } : {}),
        ...(prior?.metricsRefreshedAt ? { metricsRefreshedAt: prior.metricsRefreshedAt } : {}),
        ...pinned,
        ...(recent.length ? { recent } : {}),
        walk: {
          ...(floorId ? { floorId } : {}),
          untilId: walk.untilId,
          ...(walk.newestId ? { newestId: walk.newestId } : {}),
        },
      };
      const posts = [...byId.values()];
      return {
        records: this.withHistory(posts, self.username, limit),
        cursor,
        partial: true,
      };
    }

    let newestId = walk.newestId;
    const metricsDue =
      !firstPass && windowRefreshDue(prior?.metricsRefreshedAt, config.metricsRefreshHours, now);
    let removed: string[] = [];
    // Metrics re-walk: ONE page bounded by the window re-observes engagement
    // counts on recent posts, merged by id so refreshed items replace stale
    // raw. A single request keeps the paid-read cost of a refresh constant,
    // and the same page is what tells a deleted post from an old one.
    if (metricsDue) {
      const page = await this.timelinePage(path, {
        start_time: new Date(windowFloorMs).toISOString(),
      });
      const returned = new Set<string>();
      const pageSeen: WatchedPost[] = [];
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const item of page.items) {
        const scan = scanTweet(item);
        if (!scan) continue;
        returned.add(scan.stableId);
        pageSeen.push([scan.stableId, scan.createdAtMs]);
        oldestMs = Math.min(oldestMs, scan.createdAtMs);
        if (byId.size >= limit && !byId.has(scan.stableId)) continue;
        keepNewestVersion(byId, scan, item);
        // Only a post this batch carries may move the high-water mark: one
        // published since the walk but left out for room is the next pass's.
        newestId = maxTweetId(newestId, scan.id);
      }
      // A truncated page enumerated only what is newer than its oldest post
      // (posts sharing that instant may sit on the next page).
      const fromMs = page.nextToken ? oldestMs + 1 : windowFloorMs;
      const gone = vanishedPosts(recent, returned, fromMs);
      const goneIds = new Set(gone.map(([id]) => id));
      recent = mergeWatchedPosts(
        recent.filter(([id]) => !goneIds.has(id)),
        pageSeen,
        windowFloorMs,
      );
      removed = gone.flatMap(([id, ms]) => deletedPostRecordIds(id, ms, now));
    }

    const cursor: PostsCursor = {
      ...(newestId ? { sinceId: newestId } : {}),
      lastFetchAt: now.toISOString(),
      // The first pass is one bounded backfill; it observes metrics for
      // everything it fetches, so the refresh window starts counting from it.
      ...(metricsDue || firstPass
        ? { metricsRefreshedAt: now.toISOString() }
        : prior?.metricsRefreshedAt
          ? { metricsRefreshedAt: prior.metricsRefreshedAt }
          : {}),
      ...pinned,
      ...(recent.length ? { recent } : {}),
    };
    const posts = [...byId.values()];
    return {
      records: this.withHistory(posts, self.username, limit),
      cursor,
      ...(removed.length ? { removed } : {}),
    };
  }

  private withHistory(posts: RecordRef[], username: string, limit: number): RecordRef[] {
    const config = this.assertReady();
    return config.metricsHistory
      ? [...posts, ...this.metricsHistoryRefs(posts, username, limit - posts.length)]
      : posts;
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
    if (
      prior &&
      !prior.walk &&
      !windowRefreshDue(prior.lastFetchAt, config.syncIntervalHours, now)
    ) {
      return { records: [], cursor: prior };
    }
    const self = await this.resolveSelf(prior);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);
    const firstPass = !prior?.sinceId && !prior?.walk;
    const floorId = prior?.walk ? prior.walk.floorId : prior?.sinceId;
    const newest = prior?.walk?.newestId ?? prior?.sinceId;
    const walk = await this.walkTimeline(`/users/${encodeURIComponent(self.userId)}/mentions`, {
      ...(floorId ? { floorId } : {}),
      ...(prior?.walk ? { untilId: prior.walk.untilId } : {}),
      ...(newest ? { newestId: newest } : {}),
      limit,
      params: { expansions: 'author_id', 'user.fields': 'username' },
    });

    const records: RecordRef[] = [];
    const seen = new Set<string>();
    for (const { item, scan } of walk.items) {
      if (seen.has(scan.stableId)) continue;
      seen.add(scan.stableId);
      const authorId = (item as { author_id?: unknown }).author_id;
      const author = typeof authorId === 'string' ? walk.users.get(authorId) : undefined;
      records.push({
        id: scan.stableId,
        raw: { tweet: item, ...(author ? { author } : {}) },
        ts: scan.createdAtIso,
        ordinalKey: scan.createdAtMs,
      });
    }
    const pinned = { userId: self.userId, username: self.username };

    if (!walk.done && !firstPass && walk.untilId) {
      return {
        records,
        cursor: {
          ...(prior?.sinceId ? { sinceId: prior.sinceId } : {}),
          ...(prior?.lastFetchAt ? { lastFetchAt: prior.lastFetchAt } : {}),
          ...pinned,
          walk: {
            ...(floorId ? { floorId } : {}),
            untilId: walk.untilId,
            ...(walk.newestId ? { newestId: walk.newestId } : {}),
          },
        },
        partial: true,
      };
    }
    return {
      records,
      cursor: {
        ...(walk.newestId ? { sinceId: walk.newestId } : {}),
        lastFetchAt: now.toISOString(),
        ...pinned,
      },
    };
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
    const res = (await this.api((token) => this.runtime.getJson(url.toString(), token))) as {
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

/**
 * Add a post under its edit-stable id, keeping the newest version when one
 * response carries several (versions are ascending ids).
 */
function keepNewestVersion(byId: Map<string, RecordRef>, scan: TweetScan, item: unknown): void {
  const existing = byId.get(scan.stableId);
  const existingId = str((existing?.raw as { id?: unknown } | undefined)?.id);
  if (existingId && existingId !== scan.id && maxTweetId(existingId, scan.id) === existingId) {
    return;
  }
  byId.set(scan.stableId, {
    id: scan.stableId,
    raw: item,
    ts: scan.createdAtIso,
    ordinalKey: scan.createdAtMs,
  });
}

function reconnectError(detail?: string): Error {
  return new ReconnectRequiredError(
    `The X sign-in for this connector was revoked or has expired${detail ? ` (${detail})` : ''}. Re-link the account from the connector's settings.`,
  );
}

function budgetExhaustedError(): Error {
  return new Error(
    "X refused the request because this developer account's API credits or spending limit are used up. Add credits or raise the spending limit in the X Developer Console (console.x.com), then sync again.",
  );
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

const TWEET_ID_RE = /^\d{1,19}$/;

function parseWalk(raw: unknown): TimelineWalk | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const id = (key: string): string | undefined =>
    typeof value[key] === 'string' && TWEET_ID_RE.test(value[key] as string)
      ? (value[key] as string)
      : undefined;
  const untilId = id('untilId');
  if (!untilId) return undefined;
  const floorId = id('floorId');
  const newestId = id('newestId');
  return {
    ...(floorId ? { floorId } : {}),
    untilId,
    ...(newestId ? { newestId } : {}),
  };
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
  const recent = parseWatchedPosts(value.recent);
  const walk = parseWalk(value.walk);
  if (!sinceId && !lastFetchAt && !metricsRefreshedAt && !userId && !walk) return undefined;
  return {
    ...(sinceId ? { sinceId } : {}),
    ...(lastFetchAt ? { lastFetchAt } : {}),
    ...(metricsRefreshedAt ? { metricsRefreshedAt } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(recent.length ? { recent } : {}),
    ...(walk ? { walk } : {}),
  };
}

function parseMentionsCursor(raw: unknown): MentionsCursor | undefined {
  const parsed = parsePostsCursor(raw);
  if (!parsed) return undefined;
  const { metricsRefreshedAt: _drop, recent: _recent, ...rest } = parsed;
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

const errorStatus = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const isUnauthorized = (err: unknown): boolean => errorStatus(err) === 401;

/**
 * Pay-per-use accounts are refused once their credits or spending limit run
 * out (402), and the legacy tiers answered a spent monthly cap with a
 * `UsageCapExceeded` problem. Neither clears on a short backoff, so the pass
 * fails with a message naming the fix instead of retrying silently.
 */
function isBudgetExhausted(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === undefined) return false;
  if (status === 402) return true;
  if (status !== 403 && status !== 429) return false;
  const detail = err instanceof Error ? err.message : '';
  return /usage[ -]?cap|credits?[ _-]?(depleted|exhausted)|spend(ing)?[ -]?(limit|cap)/i.test(
    detail,
  );
}

/** 429 is X's throttle: back off and keep the cursor. */
function isRateLimitError(err: unknown): boolean {
  const status = errorStatus(err);
  return status !== undefined && isRateLimitStatus(status);
}

interface TweetScan {
  /** This version's id. */
  id: string;
  /** The id that survives edits: the original version's. */
  stableId: string;
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
  return { id, stableId: stableTweetId(item) || id, createdAtIso, createdAtMs };
}

/**
 * Every edit of an X post is a new post id; `edit_history_tweet_ids` lists
 * them oldest first, so its first entry names the post across edits.
 */
export function stableTweetId(item: unknown): string {
  const view = (item ?? {}) as { id?: unknown; edit_history_tweet_ids?: unknown };
  const history = view.edit_history_tweet_ids;
  if (Array.isArray(history) && typeof history[0] === 'string' && history[0]) return history[0];
  return typeof view.id === 'string' ? view.id : '';
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

function minTweetId(a: string | undefined, b: string): string {
  if (!a) return b;
  try {
    return BigInt(b) < BigInt(a) ? b : a;
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
  const stableId = stableTweetId(item) || id;
  const text = expandUrls(str(tweet.text), tweet.entities);
  const createdAt = str(tweet.created_at);
  const metrics = tweet.public_metrics ?? {};
  const inReplyTo = repliedToId(tweet.referenced_tweets);
  const hasMedia =
    Array.isArray(tweet.attachments?.media_keys) && tweet.attachments.media_keys.length > 0;
  const username = opts.username;
  const permalink = xPermalink(username, id);

  const frontmatter = orderedFrontmatter([
    ['title', firstLineTitle(text) || '(no text)'],
    ['date', createdAt],
    ['platform', 'x'],
    ['direction', 'inbound'],
    ['author', username || undefined],
    ['tweet_id', id],
    ['original_tweet_id', stableId !== id ? stableId : undefined],
    ['permalink', permalink],
    ['url', permalink],
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
    recordId: stableId,
    dirSegments: monthSegments(createdAt),
    fileStem: postFileStem(createdAt, text),
    frontmatter,
    bodyMarkdown: text,
    // The pass-time stamp alone is not a change worth rewriting the post for.
    volatileKeys: ['metrics_updated_at'],
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
      postId: stableTweetId(item) || id,
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
  const permalink = xPermalink(username === 'unknown' ? '' : username, id);

  const frontmatter = orderedFrontmatter([
    ['title', title],
    ['date', createdAt],
    ['platform', 'x'],
    ['direction', 'inbound'],
    ['author', username],
    ['tweet_id', id],
    ['permalink', permalink],
    ['url', permalink],
    ['in_reply_to', inReplyTo || undefined],
    ['lang', str(tweet.lang) || undefined],
  ]);

  return {
    recordId: stableTweetId(item) || id,
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
    ['direction', 'inbound'],
    ['author', username || undefined],
    ['url', username ? `https://x.com/${username}` : undefined],
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

/** Register the X native adapter; its runtime rides `deps.fetch` when present. */
export function registerXAdapters(): void {
  registerNativeAdapter('x-posts', async (binding, deps) =>
    Promise.resolve(new XPostsAdapter(binding, deps)),
  );
}
