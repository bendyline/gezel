/**
 * Bluesky as a `native` connector adapter: the account's own posts, mentions
 * of it, a daily profile-stats series, and (unless disabled) per-(post, day)
 * engagement-history observations, normalized into one markdown corpus, plus
 * a consent-gated `publish` write-back action (the `social-publish` scope in
 * connectors/consent.ts) that can embed up to four project images.
 *
 * Construct-per-pass like calendar-google: `ensureAuth` signs in with the
 * binding's app password and holds the agent for the pass. The PDS allows an
 * account only 30 sign-ins per 5 minutes and 300 per day, and the sync loop
 * may run a pass every few minutes, so the default runtime keeps each
 * account's session in memory (keyed by transport, service, handle, and a
 * hash of the password) and resumes it with its refresh token; a fresh
 * sign-in happens once per daemon start or when the session is refused.
 * Nothing about the session is persisted. The AT Protocol SDK loads lazily
 * inside the default runtime so the exported pure mappers (`postToRecord`,
 * `notificationToRecord`, `profileToStatsRecord`) stay importable without it —
 * they take the plain JSON view shapes the SDK returns, which is what the
 * golden tests pin. The default runtime rides `AdapterDeps.fetch`, so the
 * provider simulator can stand in for the PDS.
 *
 * Walks that outgrow one engine round continue from the feed cursor they
 * stopped on (`partial: true`) rather than moving the high-water mark past
 * posts they never returned, and the metrics re-walk doubles as the deletion
 * check (social-shared's deletion watch): a post deleted inside the metrics
 * window leaves the corpus along with its engagement readings.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isRateLimitStatus } from '@bendyline/gezel';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
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

const DEFAULT_SERVICE = 'https://bsky.social';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PASS = 10;
const DEFAULT_BACKFILL = 500;
const MAX_POST_GRAPHEMES = 300;
const MAX_PUBLISH_IMAGES = 4;
/** Bluesky's per-image blob limit. */
const MAX_PUBLISH_IMAGE_BYTES = 1_000_000;
const MENTION_REASONS = new Set(['mention', 'reply', 'quote']);
/** RecordRef id prefix marking a prebuilt metrics-history record in a batch. */
const METRICS_REF_PREFIX = 'metrics:';

const PUBLISH_IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

interface BlueskyConfig {
  handle: string;
  service: string;
  syncMentions: boolean;
  metricsWindowDays: number;
  metricsRefreshHours: number;
  statsIntervalHours: number;
  metricsHistory: boolean;
  allowPublish: boolean;
}

export interface BlueskyRichTextResult {
  text: string;
  facets?: unknown;
  graphemeLength: number;
}

export interface BlueskyReplyRef {
  uri: string;
  cid: string;
}

export interface BlueskyReplyRefs {
  root: BlueskyReplyRef;
  parent: BlueskyReplyRef;
}

/** The slice of an authenticated AT Protocol session the adapter consumes. */
export interface BlueskyAgentApi {
  did: string;
  getAuthorFeed(params: {
    actor: string;
    limit: number;
    cursor?: string;
  }): Promise<{ feed: unknown[]; cursor?: string }>;
  listNotifications(params: {
    limit: number;
    cursor?: string;
  }): Promise<{ notifications: unknown[]; cursor?: string }>;
  getProfile(actor: string): Promise<unknown>;
  getPosts(uris: string[]): Promise<unknown[]>;
  post(record: {
    text: string;
    facets?: unknown;
    langs?: string[];
    reply?: BlueskyReplyRefs;
    embed?: unknown;
    createdAt: string;
  }): Promise<{ uri: string; cid: string }>;
  /** Upload one image blob; the returned `blob` ref goes into the embed. */
  uploadBlob(bytes: Uint8Array, opts: { encoding: string }): Promise<{ blob: unknown }>;
  /** Facet detection; resolves @mentions to DIDs through the session. */
  richText(text: string): Promise<BlueskyRichTextResult>;
}

export interface BlueskyRuntime {
  login(opts: { service: string; identifier: string; password: string }): Promise<BlueskyAgentApi>;
  now(): Date;
}

/** The SDK's session record (`AtpSessionData`), cached between passes. */
interface AtprotoSession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  [key: string]: unknown;
}

interface AtprotoModule {
  AtpAgent: new (opts: {
    service: string;
    fetch?: typeof fetch;
    persistSession?: (event: string, session: AtprotoSession | undefined) => void;
  }) => {
    readonly session?: AtprotoSession;
    login(opts: { identifier: string; password: string }): Promise<{ data: { did: string } }>;
    resumeSession(session: AtprotoSession): Promise<unknown>;
    getAuthorFeed(params: {
      actor: string;
      limit: number;
      cursor?: string;
    }): Promise<{ data: { feed?: unknown[]; cursor?: string } }>;
    listNotifications(params: {
      limit: number;
      cursor?: string;
    }): Promise<{ data: { notifications?: unknown[]; cursor?: string } }>;
    getProfile(params: { actor: string }): Promise<{ data: unknown }>;
    getPosts(params: { uris: string[] }): Promise<{ data: { posts?: unknown[] } }>;
    post(record: Record<string, unknown>): Promise<{ uri: string; cid: string }>;
    uploadBlob(bytes: Uint8Array, opts: { encoding: string }): Promise<{ data: { blob: unknown } }>;
  };
  RichText: new (props: { text: string }) => {
    text: string;
    facets?: unknown;
    graphemeLength: number;
    detectFacets(agent: unknown): Promise<void>;
  };
}

let atprotoModule: Promise<AtprotoModule> | undefined;

function loadAtproto(): Promise<AtprotoModule> {
  atprotoModule ??= import('@atproto/api') as unknown as Promise<AtprotoModule>;
  return atprotoModule;
}

/**
 * Live sessions per transport, then per account + password. Keyed by the
 * transport so a test's or the simulator's fake world never resumes a session
 * minted by another; weak so a discarded fake takes its sessions with it.
 */
const sessionCaches = new WeakMap<typeof fetch, Map<string, AtprotoSession>>();

function sessionCacheFor(fetchImpl: typeof fetch): Map<string, AtprotoSession> {
  let cache = sessionCaches.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    sessionCaches.set(fetchImpl, cache);
  }
  return cache;
}

/**
 * The production runtime over a transport (`AdapterDeps.fetch`, else global
 * fetch). Sign-ins are rationed by the PDS, so a cached session is resumed
 * (one refresh call, which also rotates the refresh token) before falling
 * back to a fresh sign-in.
 */
export function createBlueskyRuntime(fetchImpl: typeof fetch = fetch): BlueskyRuntime {
  return {
    login: (opts) => blueskyLogin(fetchImpl, opts),
    now: () => new Date(),
  };
}

async function blueskyLogin(
  fetchImpl: typeof fetch,
  { service, identifier, password }: { service: string; identifier: string; password: string },
): Promise<BlueskyAgentApi> {
  const { AtpAgent, RichText } = await loadAtproto();
  const cache = sessionCacheFor(fetchImpl);
  const key = createHash('sha256').update(`${service}\n${identifier}\n${password}`).digest('hex');
  const makeAgent = () =>
    new AtpAgent({
      service,
      fetch: fetchImpl,
      persistSession: (event, session) => {
        if (session && (event === 'create' || event === 'update')) cache.set(key, session);
        else if (event === 'expired' || event === 'create-failed') cache.delete(key);
      },
    });
  let agent = makeAgent();
  const cached = cache.get(key);
  let resumed = false;
  if (cached) {
    try {
      await agent.resumeSession(cached);
      resumed = agent.session?.did === cached.did;
    } catch {
      cache.delete(key);
    }
  }
  if (!resumed) {
    agent = makeAgent();
    await agent.login({ identifier, password });
  }
  const live = agent;
  const did = live.session?.did ?? '';
  if (!did) throw new Error('Bluesky returned no account DID for this session.');
  return {
    did,
    getAuthorFeed: async (params) => {
      const res = await live.getAuthorFeed(params);
      return {
        feed: res.data.feed ?? [],
        ...(res.data.cursor ? { cursor: res.data.cursor } : {}),
      };
    },
    listNotifications: async (params) => {
      const res = await live.listNotifications(params);
      return {
        notifications: res.data.notifications ?? [],
        ...(res.data.cursor ? { cursor: res.data.cursor } : {}),
      };
    },
    getProfile: async (actor) => (await live.getProfile({ actor })).data,
    getPosts: async (uris) => (await live.getPosts({ uris })).data.posts ?? [],
    post: async (record) => {
      const res = await live.post(record as unknown as Record<string, unknown>);
      return { uri: res.uri, cid: res.cid };
    },
    uploadBlob: async (bytes, opts) => {
      const res = await live.uploadBlob(bytes, { encoding: opts.encoding });
      return { blob: res.data.blob };
    },
    richText: async (text) => {
      const rt = new RichText({ text });
      await rt.detectFacets(live);
      return {
        text: rt.text,
        ...(rt.facets !== undefined ? { facets: rt.facets } : {}),
        graphemeLength: rt.graphemeLength,
      };
    },
  };
}

/**
 * Where a feed walk stopped when it outgrew one engine round: the feed cursor
 * of the page it was consuming, how many of that page's entries it consumed,
 * and the last one's URI (so a page that shifted between rounds is re-found by
 * identity rather than by position).
 */
interface FeedWalk {
  page?: string;
  skip: number;
  lastUri?: string;
  /** The incremental floor the walk started from. */
  floorTs?: string;
  /** High-water mark seen so far; becomes `sinceTs` when the walk completes. */
  newestTs?: string;
}

interface PostsWalk extends FeedWalk {
  metricsDue: boolean;
  windowFloorMs: number;
  /** Watched rkeys this walk has already seen (the deletion check's evidence). */
  confirmed?: string[];
}

interface PostsCursor {
  sinceTs?: string;
  metricsRefreshedAt?: string;
  /** Deletion watch, keyed by rkey (the account DID is implied). */
  recent?: WatchedPost[];
  walk?: PostsWalk;
}

interface MentionsCursor {
  sinceTs?: string;
  walk?: FeedWalk;
}

interface StatsCursor {
  lastFetchAt: string;
  lastDay: string;
}

export class BlueskyPostsAdapter implements ConnectorAdapter {
  readonly typeId = 'bluesky-posts';
  private config?: BlueskyConfig;
  private agent?: BlueskyAgentApi;
  /** One timestamp per pass so every refreshed post carries the same stamp. */
  private syncedAt = '';
  private readonly runtime: BlueskyRuntime;
  /** An account-wide failure met earlier in this pass. */
  private accountFailure?: Error;

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    runtime?: BlueskyRuntime,
  ) {
    this.runtime = runtime ?? createBlueskyRuntime(deps.fetch);
  }

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const blob = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    const password = blob ? parseAppPassword(blob) : '';
    if (!password) {
      throw new Error(
        `No stored app password for Bluesky connector ${this.binding.id}. Add one in the connector's settings (create it under Bluesky Settings > App Passwords).`,
      );
    }
    this.syncedAt = this.runtime.now().toISOString();
    try {
      this.agent = await this.runtime.login({
        service: this.config.service,
        identifier: this.config.handle,
        password,
      });
    } catch (err) {
      const detail = err instanceof Error ? ` ${err.message}` : '';
      // A rationed sign-in is not a bad password; saying so would send the
      // person off to regenerate a credential that works.
      if (isRateLimitError(err)) {
        throw new Error(
          `Bluesky is limiting sign-ins for ${this.config.handle} right now (an account may sign in 30 times per 5 minutes and 300 times a day across all its apps). Syncing retries on its own; nothing needs to change.${detail}`,
        );
      }
      throw new Error(
        `Bluesky sign-in failed for ${this.config.handle}. Check the handle and app password (regular account passwords do not work here).${detail}`,
      );
    }
  }

  async listScopes(): Promise<string[]> {
    const { config } = this.assertReady();
    return ['posts', ...(config.syncMentions ? ['mentions'] : []), 'stats'];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    if (this.accountFailure) throw this.accountFailure;
    try {
      if (scope === 'posts') return await this.listPosts(cursor, opts);
      if (scope === 'mentions') return await this.listMentions(cursor, opts);
      if (scope === 'stats') return await this.listStats(cursor);
      return { records: [], cursor };
    } catch (err) {
      if (isRateLimitError(err)) return { records: [], cursor, rateLimited: true };
      if ((err as { status?: unknown } | null)?.status === 401) {
        // The session is the account's: the rest of the pass fails with it.
        this.accountFailure = new Error(
          `Bluesky refused this connector's session for ${this.config?.handle ?? 'the account'} (HTTP 401). If the app password was revoked, create a new one and update the connector's settings.`,
        );
        throw this.accountFailure;
      }
      throw err;
    }
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const { config } = this.assertReady();
    if (scope === 'posts') {
      // Metrics-history refs carry their prebuilt NormalizedRecord as `raw`
      // (built in the same listPosts pass) — pass it straight through.
      if (ref.id.startsWith(METRICS_REF_PREFIX)) {
        return ref.raw as NormalizedRecord;
      }
      return postToRecord(ref.raw, {
        accountHandle: config.handle,
        metricsUpdatedAt: this.syncedAt,
      });
    }
    if (scope === 'mentions') return notificationToRecord(ref.raw);
    if (scope === 'stats') {
      const raw = (ref.raw ?? {}) as { profile?: unknown; day?: unknown };
      const day = typeof raw.day === 'string' ? raw.day : '';
      return profileToStatsRecord(raw.profile, day, config.handle);
    }
    throw new Error(`unknown bluesky-posts scope '${scope}'`);
  }

  async runAction(action: string, input: unknown): Promise<unknown> {
    if (action !== 'publish') {
      throw new Error(`bluesky-posts declares no action '${action}'`);
    }
    const { agent, config } = this.assertReady();
    // The social-publish consent enforcer already gates the commit; this is
    // defense-in-depth for any future non-outbox caller.
    if (!config.allowPublish) {
      throw new Error(
        "Publishing is disabled on this Bluesky connector. Enable 'Allow publishing' in the connector's settings first.",
      );
    }
    const parsed = parsePublishInput(input);
    const rt = await agent.richText(parsed.text);
    if (rt.graphemeLength > MAX_POST_GRAPHEMES) {
      throw new Error(
        `Bluesky posts are limited to ${MAX_POST_GRAPHEMES} characters; this draft is ${rt.graphemeLength}. Shorten the text and draft again.`,
      );
    }
    // Read + validate every image (existence, size, mime) before resolving
    // the reply or uploading anything, so a bad draft never leaves orphaned
    // blobs behind.
    const images = parsed.images ? await this.readPublishImages(parsed.images) : [];
    const reply =
      parsed.replyTo ??
      (parsed.replyToUri ? await this.resolveReplyRefs(parsed.replyToUri) : undefined);
    const embed = images.length ? await this.uploadImageEmbed(images) : undefined;
    const res = await agent.post({
      text: rt.text,
      ...(rt.facets !== undefined ? { facets: rt.facets } : {}),
      ...(parsed.langs ? { langs: parsed.langs } : {}),
      ...(reply ? { reply } : {}),
      ...(embed ? { embed } : {}),
      createdAt: this.runtime.now().toISOString(),
    });
    return {
      uri: res.uri,
      cid: res.cid,
      permalink: blueskyPermalink(config.handle, res.uri),
    };
  }

  async close(): Promise<void> {}

  private assertReady(): { agent: BlueskyAgentApi; config: BlueskyConfig } {
    if (!this.agent || !this.config) {
      throw new Error('Bluesky connector has not been initialized.');
    }
    return { agent: this.agent, config: this.config };
  }

  private async listPosts(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<PostsCursor>> {
    const { agent, config } = this.assertReady();
    const prior = parsePostsCursor(cursorRaw);
    const now = this.runtime.now();
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);
    const walk = prior?.walk;
    const floorTs = walk ? walk.floorTs : prior?.sinceTs;
    const sinceMs = tsMs(floorTs);
    // The first sync is one window of the newest `limit` posts and never
    // continues; older history is deliberately not backfilled.
    const firstPass = sinceMs === undefined;
    // The first pass is one bounded backfill; it observes metrics for
    // everything it fetches, so the refresh window starts counting from it.
    const metricsDue = walk
      ? walk.metricsDue
      : !firstPass && windowRefreshDue(prior?.metricsRefreshedAt, config.metricsRefreshHours, now);
    const windowFloorMs = walk
      ? walk.windowFloorMs
      : now.getTime() - config.metricsWindowDays * 86_400_000;

    const records: RecordRef[] = [];
    const seen = new Set<string>();
    const sightings: WatchedPost[] = [];
    let newestTs = walk ? walk.newestTs : prior?.sinceTs;
    let newestMs = tsMs(newestTs) ?? Number.NEGATIVE_INFINITY;
    let page = walk?.page;
    let skip = walk?.skip ?? 0;
    let lastUri = walk?.lastUri;
    let done = false;
    let feedEnded = false;
    let full = false;

    for (let p = 0; p < MAX_PAGES_PER_PASS && !done && !full; p++) {
      const res = await agent.getAuthorFeed({
        actor: agent.did,
        limit: PAGE_SIZE,
        ...(page ? { cursor: page } : {}),
      });
      const feed = Array.isArray(res.feed) ? res.feed : [];
      let i = p === 0 ? resumeIndex(feed, skip, lastUri) : 0;
      for (; i < feed.length; i++) {
        const item = feed[i];
        const scan = scanFeedItem(item, agent.did);
        if (scan) {
          // The feed is newest-first on its sort axis (repost time for
          // reposts, otherwise indexedAt), and a post's indexedAt never
          // exceeds its sort timestamp — once the axis is past both the
          // incremental floor and the metrics window there is nothing left.
          if (
            sinceMs !== undefined &&
            scan.sortAtMs <= sinceMs &&
            (!metricsDue || scan.sortAtMs < windowFloorMs)
          ) {
            done = true;
            break;
          }
          // Reposts (and anything else not authored by the account) are
          // skipped in v1 — recorded in the connector-type notes.
          const wanted =
            scan.authored &&
            !seen.has(scan.uri) &&
            (sinceMs === undefined ||
              scan.indexedAtMs > sinceMs ||
              (metricsDue && scan.indexedAtMs >= windowFloorMs));
          if (wanted && records.length >= limit) {
            full = true;
            break;
          }
          if (scan.sortAtMs > newestMs) {
            newestMs = scan.sortAtMs;
            newestTs = scan.sortAtIso;
          }
          if (scan.authored) sightings.push([rkeyOf(scan.uri), scan.feedMs]);
          if (wanted) {
            seen.add(scan.uri);
            records.push({
              id: scan.uri,
              raw: item,
              ts: scan.indexedAtIso,
              ordinalKey: scan.indexedAtMs,
            });
          }
        }
        lastUri = feedItemUri(item) || lastUri;
      }
      if (done) break;
      if (full) {
        skip = i;
        break;
      }
      page = res.cursor;
      skip = 0;
      lastUri = undefined;
      if (!page || feed.length === 0) {
        done = true;
        feedEnded = true;
      }
    }

    let recent = mergeWatchedPosts(prior?.recent ?? [], sightings, windowFloorMs);
    const recentIds = new Set(recent.map(([id]) => id));
    const confirmed = [
      ...new Set([...(walk?.confirmed ?? []), ...sightings.map(([id]) => id)]),
    ].filter((id) => recentIds.has(id));

    if (!done && !firstPass) {
      // More than one round's worth: hold the high-water mark and resume at
      // the exact entry this round stopped before.
      const cursor: PostsCursor = {
        ...(prior?.sinceTs ? { sinceTs: prior.sinceTs } : {}),
        ...(prior?.metricsRefreshedAt ? { metricsRefreshedAt: prior.metricsRefreshedAt } : {}),
        ...(recent.length ? { recent } : {}),
        walk: {
          ...(page ? { page } : {}),
          skip,
          ...(lastUri ? { lastUri } : {}),
          ...(floorTs ? { floorTs } : {}),
          ...(newestTs ? { newestTs } : {}),
          metricsDue,
          windowFloorMs,
          ...(metricsDue && confirmed.length ? { confirmed } : {}),
        },
      };
      return { records: this.withHistory(records, limit), cursor, partial: true };
    }

    let removed: string[] = [];
    if (metricsDue && done) {
      // The walk enumerated every post at or after the window floor (all of
      // them when the feed ran out): a watched post it never met is deleted.
      const gone = vanishedPosts(
        recent,
        new Set(confirmed),
        feedEnded ? Number.NEGATIVE_INFINITY : windowFloorMs,
      );
      const goneIds = new Set(gone.map(([id]) => id));
      recent = recent.filter(([id]) => !goneIds.has(id));
      removed = gone.flatMap(([rkey, ms]) =>
        deletedPostRecordIds(postUri(agent.did, rkey), ms, now),
      );
    }

    const cursor: PostsCursor = {
      ...(newestTs ? { sinceTs: newestTs } : {}),
      ...(metricsDue || firstPass
        ? { metricsRefreshedAt: now.toISOString() }
        : prior?.metricsRefreshedAt
          ? { metricsRefreshedAt: prior.metricsRefreshedAt }
          : {}),
      ...(recent.length ? { recent } : {}),
    };
    return {
      records: this.withHistory(records, limit),
      cursor,
      ...(removed.length ? { removed } : {}),
    };
  }

  /**
   * Per-(post, day) engagement observations for the posts a pass touches —
   * new posts get their day-0 reading, re-walked posts a fresh one — budgeted
   * to the headroom left under `limit`. History refs carry the pass time as
   * their ordinal, so unbudgeted they would sort ahead of every post and the
   * engine's newest-first cap would drop real posts the cursor has already
   * moved past. Same-day re-observations dedupe via the stable recordId and
   * the writer's content-hash refresh.
   */
  private withHistory(records: RecordRef[], limit: number): RecordRef[] {
    const { config } = this.assertReady();
    const room = limit - records.length;
    if (!config.metricsHistory || room <= 0) return records;
    const history = [...records]
      .sort((a, b) => (b.ordinalKey ?? 0) - (a.ordinalKey ?? 0))
      .slice(0, room)
      .map((ref) => this.metricsHistoryRef(ref.raw, ref.id));
    return [...records, ...history];
  }

  private async listMentions(
    cursorRaw: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<MentionsCursor>> {
    const { agent } = this.assertReady();
    const prior = parseMentionsCursor(cursorRaw);
    const walk = prior?.walk;
    const floorTs = walk ? walk.floorTs : prior?.sinceTs;
    const sinceMs = tsMs(floorTs);
    const limit = Math.max(1, opts?.limit ?? DEFAULT_BACKFILL);

    const records: RecordRef[] = [];
    const seen = new Set<string>();
    let newestTs = walk ? walk.newestTs : prior?.sinceTs;
    let newestMs = tsMs(newestTs) ?? Number.NEGATIVE_INFINITY;
    let page = walk?.page;
    let skip = walk?.skip ?? 0;
    let lastUri = walk?.lastUri;
    let done = false;
    let full = false;

    for (let p = 0; p < MAX_PAGES_PER_PASS && !done && !full; p++) {
      const res = await agent.listNotifications({
        limit: PAGE_SIZE,
        ...(page ? { cursor: page } : {}),
      });
      const items = Array.isArray(res.notifications) ? res.notifications : [];
      let i = p === 0 ? resumeIndex(items, skip, lastUri) : 0;
      for (; i < items.length; i++) {
        const item = items[i];
        const scan = scanNotification(item);
        if (scan) {
          if (sinceMs !== undefined && scan.indexedAtMs <= sinceMs) {
            done = true;
            break;
          }
          const wanted = MENTION_REASONS.has(scan.reason) && !seen.has(scan.uri);
          if (wanted && records.length >= limit) {
            full = true;
            break;
          }
          if (scan.indexedAtMs > newestMs) {
            newestMs = scan.indexedAtMs;
            newestTs = scan.indexedAtIso;
          }
          if (wanted) {
            seen.add(scan.uri);
            records.push({
              id: scan.uri,
              raw: item,
              ts: scan.indexedAtIso,
              ordinalKey: scan.indexedAtMs,
            });
          }
        }
        lastUri = feedItemUri(item) || lastUri;
      }
      if (done) break;
      if (full) {
        skip = i;
        break;
      }
      page = res.cursor;
      skip = 0;
      lastUri = undefined;
      if (!page || items.length === 0) done = true;
    }

    if (!done && sinceMs !== undefined) {
      return {
        records,
        cursor: {
          ...(prior?.sinceTs ? { sinceTs: prior.sinceTs } : {}),
          walk: {
            ...(page ? { page } : {}),
            skip,
            ...(lastUri ? { lastUri } : {}),
            ...(floorTs ? { floorTs } : {}),
            ...(newestTs ? { newestTs } : {}),
          },
        },
        partial: true,
      };
    }
    return { records, cursor: { ...(newestTs ? { sinceTs: newestTs } : {}) } };
  }

  private async listStats(cursorRaw: unknown): Promise<ChangeBatch<StatsCursor>> {
    const { agent, config } = this.assertReady();
    const prior = parseStatsCursor(cursorRaw);
    const now = this.runtime.now();
    if (prior && !windowRefreshDue(prior.lastFetchAt, config.statsIntervalHours, now)) {
      return { records: [], cursor: prior };
    }
    const profile = await agent.getProfile(agent.did);
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

  private async resolveReplyRefs(parentUri: string): Promise<BlueskyReplyRefs> {
    const { agent } = this.assertReady();
    const posts = await agent.getPosts([parentUri]);
    const parent = (posts[0] ?? null) as {
      uri?: unknown;
      cid?: unknown;
      record?: { reply?: { root?: { uri?: unknown; cid?: unknown } } };
    } | null;
    const uri = typeof parent?.uri === 'string' ? parent.uri : '';
    const cid = typeof parent?.cid === 'string' ? parent.cid : '';
    if (!uri || !cid) {
      throw new Error(`Cannot reply: the post ${parentUri} was not found on Bluesky.`);
    }
    const parentRef: BlueskyReplyRef = { uri, cid };
    const root = parent?.record?.reply?.root;
    const rootUri = typeof root?.uri === 'string' ? root.uri : '';
    const rootCid = typeof root?.cid === 'string' ? root.cid : '';
    return {
      root: rootUri && rootCid ? { uri: rootUri, cid: rootCid } : parentRef,
      parent: parentRef,
    };
  }

  /**
   * Resolve + read each publish image from the project. Paths are
   * project-relative and resolve against the artifacts directory first, then
   * the workspace (the same order draft_post documents). All validation is
   * local — nothing is uploaded here.
   */
  private async readPublishImages(
    images: PublishImageInput[],
  ): Promise<Array<{ alt: string; mime: string; bytes: Uint8Array }>> {
    const { store, projectId } = this.deps;
    if (!projectId) {
      throw new Error(
        'Cannot attach images: this publish is not scoped to a project, so image paths cannot be resolved.',
      );
    }
    const bases = [
      store.projectArtifactsDir(projectId),
      await store.projectWorkspaceDir(projectId),
    ];
    const out: Array<{ alt: string; mime: string; bytes: Uint8Array }> = [];
    for (const image of images) {
      const ext = /\.([A-Za-z0-9]+)$/.exec(image.path)?.[1]?.toLowerCase();
      const mime = ext ? PUBLISH_IMAGE_MIME_BY_EXT[ext] : undefined;
      if (!mime) {
        throw new Error(
          `Unsupported image type for ${image.path}: Bluesky embeds accept png, jpg, jpeg, webp, or gif files.`,
        );
      }
      const abs = await this.resolvePublishImagePath(bases, image.path);
      const size = (await stat(abs)).size;
      if (size > MAX_PUBLISH_IMAGE_BYTES) {
        throw new Error(
          `Image ${image.path} is ${size} bytes; Bluesky's limit is ${MAX_PUBLISH_IMAGE_BYTES} bytes per image. Compress or resize it and draft again.`,
        );
      }
      out.push({ alt: image.alt ?? '', mime, bytes: await readFile(abs) });
    }
    return out;
  }

  /** Artifacts-then-workspace resolution with the shared path-safety fences. */
  private async resolvePublishImagePath(bases: string[], relPath: string): Promise<string> {
    for (const base of bases) {
      const joined = safeJoin(base, relPath);
      if (joined === null) {
        // Traversal/absolute/unsafe segments are base-independent — reject
        // outright rather than reporting a misleading "not found".
        throw new Error(
          `Image path ${relPath} escapes the project directories; use a path relative to the project's artifacts or workspace.`,
        );
      }
      const isFile = await stat(joined).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!isFile) continue;
      if (!(await realpathContained(base, joined))) {
        throw new Error(
          `Image path ${relPath} resolves outside the project (symlink escape); refusing to attach it.`,
        );
      }
      return joined;
    }
    throw new Error(
      `Image not found: ${relPath}. Image paths resolve against the project's artifacts directory first, then its workspace.`,
    );
  }

  private async uploadImageEmbed(
    images: Array<{ alt: string; mime: string; bytes: Uint8Array }>,
  ): Promise<unknown> {
    const { agent } = this.assertReady();
    const uploaded: Array<{ image: unknown; alt: string }> = [];
    for (const image of images) {
      const { blob } = await agent.uploadBlob(image.bytes, { encoding: image.mime });
      uploaded.push({ image: blob, alt: image.alt });
    }
    return { $type: 'app.bsky.embed.images', images: uploaded };
  }

  /**
   * One engagement observation for a post this pass fetched or re-walked,
   * prebuilt as a NormalizedRecord and threaded through the batch as a
   * RecordRef whose `raw` IS the record (fetchRecord passes it through).
   * `observedAt` is the pass timestamp — the same stamp postToRecord writes
   * as `metrics_updated_at` — so the reading and the refreshed post agree.
   */
  private metricsHistoryRef(item: unknown, uri: string): RecordRef {
    const { config } = this.assertReady();
    const view = item as {
      post?: {
        author?: { handle?: unknown };
        record?: { text?: unknown };
        replyCount?: unknown;
        repostCount?: unknown;
        likeCount?: unknown;
        quoteCount?: unknown;
      };
    };
    const post = view.post ?? {};
    const handle = str(post.author?.handle) || config.handle;
    const record = metricsHistoryRecord(
      {
        platform: 'bluesky',
        postId: uri,
        permalink: blueskyPermalink(handle, uri),
        title: firstLineTitle(str(post.record?.text)),
        observedAt: this.syncedAt,
        counts: [
          ['likes', countNum(post.likeCount)],
          ['reposts', countNum(post.repostCount)],
          ['replies', countNum(post.replyCount)],
          ['quotes', countNum(post.quoteCount)],
        ],
      },
      {
        scanOrigin: 'bluesky-posts',
        quarantineNamespace: 'bluesky-posts',
        quarantineLabel: 'Metrics reading',
      },
    );
    return {
      id: record.recordId,
      raw: record,
      ts: this.syncedAt,
      // Observation time, so the engine's newest-first cap keeps the pass's
      // readings ahead of older post refs.
      ordinalKey: tsMs(this.syncedAt) ?? 0,
    };
  }
}

// ── config + secret parsing ────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown> | undefined): BlueskyConfig {
  const handle = typeof raw?.handle === 'string' ? raw.handle.trim().replace(/^@/, '') : '';
  if (!handle) {
    throw new Error('Bluesky handle is required (e.g. yourname.bsky.social).');
  }
  const service =
    typeof raw?.service === 'string' && raw.service.trim()
      ? raw.service.trim().replace(/\/+$/, '')
      : DEFAULT_SERVICE;
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  return {
    handle,
    service,
    syncMentions: raw?.syncMentions !== false,
    metricsWindowDays: num(raw?.metricsWindowDays, 30, 1, 365),
    metricsRefreshHours: num(raw?.metricsRefreshHours, 6, 0.25, 24 * 30),
    statsIntervalHours: num(raw?.statsIntervalHours, 6, 0.25, 24 * 30),
    metricsHistory: raw?.metricsHistory !== false,
    allowPublish: raw?.allowPublish === true,
  };
}

/** The stored secret is a plain app password or `{"appPassword": "..."}`. */
export function parseAppPassword(blob: string): string {
  const trimmed = blob.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { appPassword?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.appPassword === 'string') {
        return parsed.appPassword.trim();
      }
    } catch {
      // Fall through: a password that merely starts with `{`.
    }
  }
  return trimmed;
}

// ── cursor + input parsing ─────────────────────────────────────────────────

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** A continuation only ever exists above an incremental floor. */
function parseFeedWalk(raw: unknown): FeedWalk | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const floorTs = nonEmpty(value.floorTs);
  if (!floorTs || tsMs(floorTs) === undefined) return undefined;
  const page = nonEmpty(value.page);
  const lastUri = nonEmpty(value.lastUri);
  const newestTs = nonEmpty(value.newestTs);
  const skip =
    typeof value.skip === 'number' && Number.isInteger(value.skip) && value.skip >= 0
      ? value.skip
      : 0;
  return {
    ...(page ? { page } : {}),
    skip,
    ...(lastUri ? { lastUri } : {}),
    floorTs,
    ...(newestTs ? { newestTs } : {}),
  };
}

function parsePostsWalk(raw: unknown): PostsWalk | undefined {
  const base = parseFeedWalk(raw);
  if (!base) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.windowFloorMs !== 'number' || !Number.isFinite(value.windowFloorMs)) {
    return undefined;
  }
  const confirmed = Array.isArray(value.confirmed)
    ? value.confirmed.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  return {
    ...base,
    metricsDue: value.metricsDue === true,
    windowFloorMs: value.windowFloorMs,
    ...(confirmed.length ? { confirmed } : {}),
  };
}

function parsePostsCursor(raw: unknown): PostsCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const sinceTs = nonEmpty(value.sinceTs);
  const metricsRefreshedAt = nonEmpty(value.metricsRefreshedAt);
  const recent = parseWatchedPosts(value.recent);
  const walk = parsePostsWalk(value.walk);
  if (!sinceTs && !metricsRefreshedAt && !walk) return undefined;
  return {
    ...(sinceTs ? { sinceTs } : {}),
    ...(metricsRefreshedAt ? { metricsRefreshedAt } : {}),
    ...(recent.length ? { recent } : {}),
    ...(walk ? { walk } : {}),
  };
}

function parseMentionsCursor(raw: unknown): MentionsCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const sinceTs = nonEmpty(value.sinceTs);
  const walk = parseFeedWalk(value.walk);
  if (!sinceTs && !walk) return undefined;
  return { ...(sinceTs ? { sinceTs } : {}), ...(walk ? { walk } : {}) };
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

interface PublishImageInput {
  /** Project-relative path (artifacts dir first, then workspace). */
  path: string;
  alt?: string;
}

interface PublishInput {
  text: string;
  langs?: string[];
  replyTo?: BlueskyReplyRefs;
  replyToUri?: string;
  images?: PublishImageInput[];
}

function parseReplyRef(raw: unknown, which: string): BlueskyReplyRef {
  const value = (raw ?? null) as { uri?: unknown; cid?: unknown } | null;
  const uri = typeof value?.uri === 'string' ? value.uri : '';
  const cid = typeof value?.cid === 'string' ? value.cid : '';
  if (!uri || !cid) {
    throw new Error(`publish replyTo.${which} must carry both uri and cid`);
  }
  return { uri, cid };
}

function parsePublishImages(raw: unknown): PublishImageInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('publish images must be an array of { path, alt } entries');
  }
  if (raw.length > MAX_PUBLISH_IMAGES) {
    throw new Error(
      `Bluesky posts can embed at most ${MAX_PUBLISH_IMAGES} images; this draft attaches ${raw.length}. Drop some and draft again.`,
    );
  }
  const images = raw.map((entry, index) => {
    const value = (entry ?? null) as { path?: unknown; alt?: unknown } | null;
    const path = typeof value?.path === 'string' ? value.path.trim() : '';
    if (!path) {
      throw new Error(
        `publish images[${index}] needs a string path (relative to the project's artifacts or workspace)`,
      );
    }
    const alt = typeof value?.alt === 'string' ? value.alt : '';
    return { path, ...(alt ? { alt } : {}) };
  });
  return images.length ? images : undefined;
}

function parsePublishInput(input: unknown): PublishInput {
  if (!input || typeof input !== 'object') {
    throw new Error('publish input must be an object with a text field');
  }
  const value = input as Record<string, unknown>;
  const text = typeof value.text === 'string' ? value.text : '';
  if (!text.trim()) throw new Error('publish requires non-empty post text');
  const langs = Array.isArray(value.langs)
    ? value.langs.filter((l): l is string => typeof l === 'string' && !!l.trim())
    : [];
  const replyToUri =
    typeof value.replyToUri === 'string' && value.replyToUri.trim()
      ? value.replyToUri.trim()
      : undefined;
  const replyTo =
    value.replyTo !== undefined && value.replyTo !== null
      ? {
          root: parseReplyRef((value.replyTo as Record<string, unknown>).root, 'root'),
          parent: parseReplyRef((value.replyTo as Record<string, unknown>).parent, 'parent'),
        }
      : undefined;
  const images = parsePublishImages(value.images);
  return {
    text,
    ...(langs.length ? { langs } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(replyToUri ? { replyToUri } : {}),
    ...(images ? { images } : {}),
  };
}

// ── feed scanning ──────────────────────────────────────────────────────────

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

function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && isRateLimitStatus(status);
}

interface FeedScan {
  uri: string;
  indexedAtIso: string;
  indexedAtMs: number;
  sortAtIso: string;
  sortAtMs: number;
  /**
   * The AppView's own ordering key for an authored post: the earlier of its
   * createdAt and indexedAt. A backdated post (an import) sorts by createdAt,
   * far below where its indexedAt would put it, so the deletion watch keys on
   * this rather than on indexedAt.
   */
  feedMs: number;
  authored: boolean;
}

function scanFeedItem(item: unknown, accountDid: string): FeedScan | null {
  if (!item || typeof item !== 'object') return null;
  const view = item as {
    post?: {
      uri?: unknown;
      indexedAt?: unknown;
      author?: { did?: unknown };
      record?: { createdAt?: unknown };
    };
    reason?: { indexedAt?: unknown };
  };
  const post = view.post;
  if (!post || typeof post !== 'object') return null;
  const uri = typeof post.uri === 'string' ? post.uri : '';
  const indexedAtIso = typeof post.indexedAt === 'string' ? post.indexedAt : '';
  const indexedAtMs = tsMs(indexedAtIso);
  if (!uri || indexedAtMs === undefined) return null;
  const reasonIso =
    view.reason && typeof view.reason === 'object' && typeof view.reason.indexedAt === 'string'
      ? view.reason.indexedAt
      : undefined;
  const reasonMs = tsMs(reasonIso);
  const createdAtMs = tsMs(
    typeof post.record?.createdAt === 'string' ? post.record.createdAt : undefined,
  );
  return {
    uri,
    indexedAtIso,
    indexedAtMs,
    sortAtIso: reasonMs !== undefined ? (reasonIso as string) : indexedAtIso,
    sortAtMs: reasonMs ?? indexedAtMs,
    feedMs: Math.min(indexedAtMs, createdAtMs ?? indexedAtMs),
    authored:
      view.reason == null && typeof post.author?.did === 'string' && post.author.did === accountDid,
  };
}

/** The URI that identifies a feed or notification entry (for resuming a page). */
function feedItemUri(item: unknown): string {
  const view = (item ?? null) as { uri?: unknown; post?: { uri?: unknown } } | null;
  if (typeof view?.post?.uri === 'string') return view.post.uri;
  return typeof view?.uri === 'string' ? view.uri : '';
}

/**
 * Where to resume inside a re-fetched page: just past the last entry already
 * consumed when it is still there, else by position.
 */
function resumeIndex(items: unknown[], skip: number, lastUri: string | undefined): number {
  if (lastUri) {
    const at = items.findIndex((item) => feedItemUri(item) === lastUri);
    if (at >= 0) return at + 1;
  }
  return Math.min(skip, items.length);
}

/** An account-authored post's record key — what the deletion watch stores. */
function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? uri;
}

function postUri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

interface NotificationScan {
  uri: string;
  reason: string;
  indexedAtIso: string;
  indexedAtMs: number;
}

function scanNotification(item: unknown): NotificationScan | null {
  if (!item || typeof item !== 'object') return null;
  const view = item as { uri?: unknown; reason?: unknown; indexedAt?: unknown };
  const uri = typeof view.uri === 'string' ? view.uri : '';
  const indexedAtIso = typeof view.indexedAt === 'string' ? view.indexedAt : '';
  const indexedAtMs = tsMs(indexedAtIso);
  if (!uri || indexedAtMs === undefined) return null;
  return {
    uri,
    reason: typeof view.reason === 'string' ? view.reason : '',
    indexedAtIso,
    indexedAtMs,
  };
}

// ── pure record mappers (golden-tested; plain JSON in, NormalizedRecord out) ─

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const count = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';

/** Numeric count or undefined — history observations drop absent counts. */
const countNum = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** `at://did/collection/rkey` → `https://bsky.app/profile/<handle>/post/<rkey>`. */
export function blueskyPermalink(handle: string, atUri: string): string {
  const rkey = atUri.split('/').pop() ?? '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function postTitle(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return '(no text)';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
}

interface BskyEmbedDescription {
  hasMedia: boolean;
  extras: string[];
}

function describeEmbed(embed: unknown): BskyEmbedDescription {
  if (!embed || typeof embed !== 'object') return { hasMedia: false, extras: [] };
  const view = embed as {
    $type?: unknown;
    images?: unknown;
    external?: unknown;
    media?: unknown;
  };
  const type = typeof view.$type === 'string' ? view.$type : '';
  if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    // The quoted record itself is not media; only the media half counts.
    return describeEmbed(view.media);
  }
  if (type.startsWith('app.bsky.embed.images')) {
    const alts = (Array.isArray(view.images) ? view.images : [])
      .map((image) =>
        image && typeof image === 'object' ? str((image as { alt?: unknown }).alt) : '',
      )
      .filter(Boolean)
      .map((alt) => `Image: ${alt}`);
    return { hasMedia: true, extras: alts };
  }
  if (type.startsWith('app.bsky.embed.video')) return { hasMedia: true, extras: [] };
  if (
    type.startsWith('app.bsky.embed.external') &&
    view.external &&
    typeof view.external === 'object'
  ) {
    const external = view.external as { uri?: unknown; title?: unknown; description?: unknown };
    const title = str(external.title);
    const description = str(external.description);
    const uri = str(external.uri);
    const lines = [`Link: ${title || uri}`, description, uri].filter(Boolean);
    return { hasMedia: false, extras: [lines.join('\n')] };
  }
  return { hasMedia: false, extras: [] };
}

export interface PostRecordOptions {
  /** The bound account's handle (permalink fallback + quarantine label). */
  accountHandle: string;
  /** ISO timestamp of this sync pass — when the counts were observed. */
  metricsUpdatedAt: string;
}

/** Map one `app.bsky.feed.defs#feedViewPost` JSON item to a corpus record. */
export function postToRecord(item: unknown, opts: PostRecordOptions): NormalizedRecord {
  const view = (item ?? {}) as {
    post?: {
      uri?: unknown;
      author?: { handle?: unknown };
      record?: unknown;
      embed?: unknown;
      replyCount?: unknown;
      repostCount?: unknown;
      likeCount?: unknown;
      quoteCount?: unknown;
      indexedAt?: unknown;
    };
  };
  const post = view.post ?? {};
  const uri = str(post.uri);
  if (!uri) throw new Error('Bluesky post view is missing its at:// uri.');
  const record = (post.record ?? {}) as {
    text?: unknown;
    createdAt?: unknown;
    langs?: unknown;
    reply?: { parent?: { uri?: unknown } };
  };
  const authorHandle = str(post.author?.handle) || opts.accountHandle;
  const text = str(record.text);
  const createdAt = str(record.createdAt) || str(post.indexedAt);
  const inReplyTo = str(record.reply?.parent?.uri);
  const lang = Array.isArray(record.langs) ? str(record.langs[0]) : '';
  const embed = describeEmbed(post.embed);
  const permalink = blueskyPermalink(authorHandle, uri);

  const frontmatter = orderedFrontmatter([
    ['title', postTitle(text)],
    ['date', createdAt],
    ['platform', 'bluesky'],
    ['direction', 'inbound'],
    ['author', authorHandle],
    ['uri', uri],
    ['permalink', permalink],
    ['url', permalink],
    ['in_reply_to', inReplyTo || undefined],
    ['likes', count(post.likeCount)],
    ['reposts', count(post.repostCount)],
    ['replies', count(post.replyCount)],
    ['quotes', count(post.quoteCount)],
    ['lang', lang || undefined],
    ['has_media', embed.hasMedia],
    ['metrics_updated_at', opts.metricsUpdatedAt],
  ]);

  return {
    recordId: uri,
    dirSegments: monthSegments(createdAt),
    fileStem: postFileStem(createdAt, text),
    frontmatter,
    bodyMarkdown: [text, ...embed.extras].filter(Boolean).join('\n\n'),
    // The pass-time stamp alone is not a change worth rewriting the post for.
    volatileKeys: ['metrics_updated_at'],
    scanOrigin: 'bluesky-posts',
    quarantineNamespace: 'bluesky-posts',
    quarantineLabel: `Bluesky post by @${authorHandle}`,
  };
}

/** Map one `listNotifications` JSON item (mention/reply/quote) to a record. */
export function notificationToRecord(item: unknown): NormalizedRecord {
  const view = (item ?? {}) as {
    uri?: unknown;
    author?: { handle?: unknown };
    reason?: unknown;
    record?: unknown;
    indexedAt?: unknown;
  };
  const uri = str(view.uri);
  if (!uri) throw new Error('Bluesky notification is missing its at:// uri.');
  const reason = str(view.reason) || 'mention';
  const authorHandle = str(view.author?.handle) || 'unknown';
  const record = (view.record ?? {}) as {
    text?: unknown;
    createdAt?: unknown;
    reply?: { parent?: { uri?: unknown } };
  };
  const date = str(record.createdAt) || str(view.indexedAt);
  const title = `${reason} from ${authorHandle}`;
  const inReplyTo = str(record.reply?.parent?.uri);
  const permalink = blueskyPermalink(authorHandle, uri);

  const frontmatter = orderedFrontmatter([
    ['title', title],
    ['date', date],
    ['platform', 'bluesky'],
    ['direction', 'inbound'],
    ['reason', reason],
    ['author', authorHandle],
    ['uri', uri],
    ['permalink', permalink],
    ['url', permalink],
    ['in_reply_to', inReplyTo || undefined],
  ]);

  return {
    recordId: uri,
    dirSegments: monthSegments(date),
    fileStem: postFileStem(date, title),
    frontmatter,
    bodyMarkdown: str(record.text),
    scanOrigin: 'bluesky-posts',
    quarantineNamespace: 'bluesky-posts',
    quarantineLabel: `Bluesky ${reason} from @${authorHandle}`,
  };
}

/** Map one `getProfile` JSON payload to the day's stats record. */
export function profileToStatsRecord(
  profile: unknown,
  day: string,
  accountHandle: string,
): NormalizedRecord {
  const view = (profile ?? {}) as {
    handle?: unknown;
    followersCount?: unknown;
    followsCount?: unknown;
    postsCount?: unknown;
  };
  const handle = str(view.handle) || accountHandle;
  const followers = count(view.followersCount);
  const following = count(view.followsCount);
  const postsCount = count(view.postsCount);

  const frontmatter = orderedFrontmatter([
    ['title', `Account stats ${day}`],
    ['date', day],
    ['platform', 'bluesky'],
    ['direction', 'inbound'],
    ['author', handle],
    ['url', handle ? `https://bsky.app/profile/${handle}` : undefined],
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
    scanOrigin: 'bluesky-posts',
    quarantineNamespace: 'bluesky-posts',
    quarantineLabel: `Bluesky account stats for @${handle}`,
  };
}

/** Register the Bluesky native adapter. */
export function registerBlueskyAdapters(): void {
  registerNativeAdapter('bluesky-posts', async (binding, deps) =>
    Promise.resolve(new BlueskyPostsAdapter(binding, deps)),
  );
}
