import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { OAuthTokens, RefreshTokenParams } from '../oauth.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import { XApiError, XPostsAdapter, type XRuntime } from './x-posts.js';

const USER_ID = '9001';
const USERNAME = 'testerx';

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'x-1', type: 'x-posts', config };
}

function cred(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: 'tok-1',
    refreshToken: 'refresh-1',
    expiresAt: '2999-01-01T00:00:00.000Z',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    ...overrides,
  });
}

function makeDeps(initialBlob: string | null): { deps: AdapterDeps; secrets: Map<string, string> } {
  const map = new Map<string, string>();
  if (initialBlob !== null) map.set('connector-x-posts:x-1', initialBlob);
  const keyOf = (k: { toolsetId: string; fieldId: string }) => `${k.toolsetId}:${k.fieldId}`;
  return {
    deps: {
      secrets: {
        get: async (k: { toolsetId: string; fieldId: string }) => map.get(keyOf(k)) ?? null,
        set: async (k: { toolsetId: string; fieldId: string }, v: string) => {
          map.set(keyOf(k), v);
        },
      } as unknown as SecretStore,
      store: {} as Store,
    },
    secrets: map,
  };
}

function tweet(
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text: `post ${id}`,
    created_at: createdAt,
    public_metrics: {
      retweet_count: 1,
      reply_count: 2,
      like_count: 3,
      quote_count: 0,
      bookmark_count: 0,
      impression_count: 50,
    },
    ...extra,
  };
}

interface HarnessState {
  timeline: Record<string, unknown>[];
  mentions: Record<string, unknown>[];
  mentionAuthors: Record<string, string>;
  profile: Record<string, unknown>;
  now: Date;
  requests: string[];
  refreshCalls: RefreshTokenParams[];
  refreshResult: OAuthTokens;
  listError: unknown;
  published: { url: string; token: string; body: unknown }[];
  publishResult: Record<string, unknown>;
  publishError: unknown;
}

function harness(): { runtime: XRuntime; state: HarnessState } {
  const state: HarnessState = {
    timeline: [],
    mentions: [],
    mentionAuthors: {},
    profile: { id: USER_ID, username: USERNAME },
    now: new Date('2026-08-12T12:00:00.000Z'),
    requests: [],
    refreshCalls: [],
    refreshResult: {
      accessToken: 'tok-2',
      refreshToken: 'refresh-2',
      expiresAt: '2999-01-02T00:00:00.000Z',
    },
    listError: undefined,
    published: [],
    publishResult: { data: { id: '1955000000000000009', text: 'posted' } },
    publishError: undefined,
  };

  const sortDesc = (items: Record<string, unknown>[]) =>
    [...items].sort((a, b) => (BigInt(String(b.id)) > BigInt(String(a.id)) ? 1 : -1));

  const pageOf = (items: Record<string, unknown>[], u: URL) => {
    let filtered = sortDesc(items);
    const sinceId = u.searchParams.get('since_id');
    if (sinceId) filtered = filtered.filter((t) => BigInt(String(t.id)) > BigInt(sinceId));
    const startTime = u.searchParams.get('start_time');
    if (startTime) {
      const floor = Date.parse(startTime);
      filtered = filtered.filter((t) => Date.parse(String(t.created_at)) >= floor);
    }
    const offset = Number(u.searchParams.get('pagination_token') ?? '0');
    const max = Number(u.searchParams.get('max_results') ?? '100');
    const slice = filtered.slice(offset, offset + max);
    const nextOffset = offset + slice.length;
    return { slice, nextToken: nextOffset < filtered.length ? String(nextOffset) : undefined };
  };

  const runtime: XRuntime = {
    getJson: async (url) => {
      state.requests.push(url);
      const u = new URL(url);
      if (u.pathname === '/2/users/me') {
        return { data: { ...state.profile } };
      }
      if (u.pathname === `/2/users/${USER_ID}/tweets`) {
        if (state.listError) throw state.listError;
        const { slice, nextToken } = pageOf(state.timeline, u);
        return {
          data: slice,
          meta: { result_count: slice.length, ...(nextToken ? { next_token: nextToken } : {}) },
        };
      }
      if (u.pathname === `/2/users/${USER_ID}/mentions`) {
        if (state.listError) throw state.listError;
        const { slice, nextToken } = pageOf(state.mentions, u);
        const users = [...new Set(slice.map((t) => String(t.author_id)))]
          .filter((id) => state.mentionAuthors[id])
          .map((id) => ({ id, username: state.mentionAuthors[id] }));
        return {
          data: slice,
          includes: { users },
          meta: { result_count: slice.length, ...(nextToken ? { next_token: nextToken } : {}) },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    postJson: async (url, accessToken, body) => {
      state.published.push({ url, token: accessToken, body });
      if (state.publishError) throw state.publishError;
      return { ...state.publishResult };
    },
    refreshToken: async (params) => {
      state.refreshCalls.push(params);
      return state.refreshResult;
    },
    now: () => state.now,
  };
  return { runtime, state };
}

async function readyAdapter(
  config: Record<string, unknown> = {},
  blob: string | null = cred(),
): Promise<{
  adapter: XPostsAdapter;
  state: HarnessState;
  secrets: Map<string, string>;
  makeAdapter: () => Promise<XPostsAdapter>;
}> {
  const { runtime, state } = harness();
  const { deps, secrets } = makeDeps(blob);
  const makeAdapter = async () => {
    const a = new XPostsAdapter(binding(config), deps, runtime);
    await a.ensureAuth();
    return a;
  };
  const adapter = await makeAdapter();
  return { adapter, state, secrets, makeAdapter };
}

const localDayOf = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const T1 = '2026-08-12T08:00:00.000Z';
const T2 = '2026-08-12T09:00:00.000Z';
const T3 = '2026-08-12T10:00:00.000Z';
const T4 = '2026-08-12T11:00:00.000Z';

describe('XPostsAdapter auth', () => {
  it('fails ensureAuth with an actionable message when no credential is stored', async () => {
    const { runtime } = harness();
    const { deps } = makeDeps(null);
    const adapter = new XPostsAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/No stored credential/);
  });

  it('refreshes an expired token and re-persists the ROTATED refresh token', async () => {
    const { state, secrets } = await readyAdapter(
      {},
      cred({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(state.refreshCalls).toHaveLength(1);
    expect(state.refreshCalls[0]).toMatchObject({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
    });
    expect(state.refreshCalls[0]!.endpoints.tokenEndpoint).toBe('https://api.x.com/2/oauth2/token');
    const persisted = JSON.parse(secrets.get('connector-x-posts:x-1')!) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      accessToken: 'tok-2',
      refreshToken: 'refresh-2',
      expiresAt: '2999-01-02T00:00:00.000Z',
      clientId: 'client-1',
    });
  });

  it('does not refresh a live token, and fails actionably when expired without a refresh token', async () => {
    const { state } = await readyAdapter();
    expect(state.refreshCalls).toEqual([]);

    const { runtime } = harness();
    const { deps } = makeDeps(
      cred({ expiresAt: '2000-01-01T00:00:00.000Z', refreshToken: undefined }),
    );
    const adapter = new XPostsAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/no refresh token/i);
  });

  it('lists scopes per config: mentions OFF by default (paid reads), stats always', async () => {
    const { adapter } = await readyAdapter();
    expect(await adapter.listScopes()).toEqual(['posts', 'stats']);

    const { adapter: withMentions } = await readyAdapter({ syncMentions: true });
    expect(await withMentions.listScopes()).toEqual(['posts', 'mentions', 'stats']);
  });
});

describe('XPostsAdapter posts scope', () => {
  it('backfills on the first pass, resolving the user ONCE and pinning it in the cursor', async () => {
    const { adapter, state } = await readyAdapter();
    state.timeline = [tweet('103', T3), tweet('102', T2), tweet('101', T1)];

    const first = await adapter.listChangesSince('posts', undefined);
    expect(first.records.map((r) => r.id)).toEqual([
      '103',
      '102',
      '101',
      'metrics:103:2026-08-12',
      'metrics:102:2026-08-12',
      'metrics:101:2026-08-12',
    ]);
    expect(first.rateLimited).toBeUndefined();
    expect((first as { enumeratedAll?: boolean }).enumeratedAll).toBeUndefined();
    expect(first.cursor).toEqual({
      sinceId: '103',
      lastFetchAt: '2026-08-12T12:00:00.000Z',
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
      userId: USER_ID,
      username: USERNAME,
    });
    expect(state.requests.filter((u) => u.includes('/users/me'))).toHaveLength(1);
  });

  it('budget gate: within syncIntervalHours the pass makes ZERO requests and keeps the cursor', async () => {
    const { adapter, state } = await readyAdapter();
    state.timeline = [tweet('103', T3)];
    const first = await adapter.listChangesSince('posts', undefined);

    state.now = new Date('2026-08-12T13:00:00.000Z');
    state.requests.length = 0;
    const gated = await adapter.listChangesSince('posts', first.cursor);
    expect(gated.records).toEqual([]);
    expect(gated.cursor).toEqual(first.cursor);
    expect(state.requests).toEqual([]);
  });

  it('resumes from since_id past the interval, skipping /users/me via the cached cursor', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter();
    state.timeline = [tweet('103', T3), tweet('102', T2), tweet('101', T1)];
    const first = await adapter.listChangesSince('posts', undefined);

    state.timeline = [tweet('104', T4), ...state.timeline];
    state.now = new Date('2026-08-12T17:00:00.000Z');
    state.requests.length = 0;
    // A fresh adapter proves the account id survives in the cursor, not in
    // per-pass memory.
    const nextPass = await makeAdapter();
    const second = await nextPass.listChangesSince('posts', first.cursor);
    expect(second.records.map((r) => r.id)).toEqual(['104', 'metrics:104:2026-08-12']);
    expect(state.requests.some((u) => u.includes('/users/me'))).toBe(false);
    expect(state.requests.some((u) => u.includes('since_id=103'))).toBe(true);
    expect(second.cursor).toEqual({
      sinceId: '104',
      lastFetchAt: '2026-08-12T17:00:00.000Z',
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
      userId: USER_ID,
      username: USERNAME,
    });
  });

  it('re-walks ONE window-bounded page when the metrics refresh is due, merged and restamped', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter();
    state.timeline = [
      tweet('104', T4),
      tweet('103', T3),
      tweet('102', T2),
      tweet('101', T1),
      // Outside the 7-day metrics window; must not resurface.
      tweet('90', '2026-06-01T00:00:00.000Z'),
    ];
    const first = await adapter.listChangesSince('posts', undefined);

    // 25h later (metricsRefreshHours default 24): incremental has nothing new,
    // the window page re-observes engagement on everything recent.
    state.now = new Date('2026-08-13T13:00:00.000Z');
    state.requests.length = 0;
    const nextPass = await makeAdapter();
    const third = await nextPass.listChangesSince('posts', first.cursor);
    expect(third.records.map((r) => r.id)).toEqual([
      '104',
      '103',
      '102',
      '101',
      'metrics:104:2026-08-13',
      'metrics:103:2026-08-13',
      'metrics:102:2026-08-13',
      'metrics:101:2026-08-13',
    ]);
    const walk = state.requests.find((u) => u.includes('start_time='));
    expect(walk).toBeTruthy();
    expect(walk).not.toContain('since_id');
    expect(third.cursor).toEqual({
      sinceId: '104',
      lastFetchAt: '2026-08-13T13:00:00.000Z',
      metricsRefreshedAt: '2026-08-13T13:00:00.000Z',
      userId: USER_ID,
      username: USERNAME,
    });
  });

  it('stamps metrics_updated_at from the pass and maps the raw tweet on fetch', async () => {
    const { adapter, state } = await readyAdapter();
    state.timeline = [tweet('103', T3)];
    const batch = await adapter.listChangesSince('posts', undefined);
    const record = await adapter.fetchRecord('posts', batch.records[0]!);
    expect(record.recordId).toBe('103');
    expect(record.frontmatter.author).toBe(USERNAME);
    expect(record.frontmatter.permalink).toBe(`https://x.com/${USERNAME}/status/103`);
    expect(record.frontmatter.likes).toBe('3');
    expect(record.frontmatter.metrics_updated_at).toBe('2026-08-12T12:00:00.000Z');
  });

  it('maps 429 and usage-cap 403s to a rateLimited batch, rethrowing other faults', async () => {
    const { adapter, state } = await readyAdapter();
    const cursor = {
      sinceId: '103',
      lastFetchAt: '2026-08-12T00:00:00.000Z',
      metricsRefreshedAt: '2026-08-12T11:00:00.000Z',
      userId: USER_ID,
      username: USERNAME,
    };

    state.listError = new XApiError(429, 'Too Many Requests');
    const limited = await adapter.listChangesSince('posts', cursor);
    expect(limited).toEqual({ records: [], cursor, rateLimited: true });

    state.listError = new XApiError(403, 'UsageCapExceeded: Monthly product cap');
    const capped = await adapter.listChangesSince('posts', cursor);
    expect(capped).toEqual({ records: [], cursor, rateLimited: true });

    state.listError = new XApiError(500, 'oops');
    await expect(adapter.listChangesSince('posts', cursor)).rejects.toThrow(/x api 500/);
  });
});

describe('XPostsAdapter mentions scope', () => {
  it('resumes from since_id, resolves authors from includes, and budget-gates like posts', async () => {
    const { adapter, state } = await readyAdapter({ syncMentions: true });
    state.mentions = [
      { ...tweet('201', T2), author_id: '777001', text: 'hey @testerx' },
      { ...tweet('200', T1), author_id: '777002', text: 'cc @testerx' },
    ];
    state.mentionAuthors = { '777001': 'alice', '777002': 'bob' };

    const first = await adapter.listChangesSince('mentions', undefined);
    expect(first.records.map((r) => r.id)).toEqual(['201', '200']);
    expect(first.cursor).toEqual({
      sinceId: '201',
      lastFetchAt: '2026-08-12T12:00:00.000Z',
      userId: USER_ID,
      username: USERNAME,
    });
    const record = await adapter.fetchRecord('mentions', first.records[0]!);
    expect(record.frontmatter.author).toBe('alice');
    expect(record.frontmatter.permalink).toBe('https://x.com/alice/status/201');

    state.mentions = [{ ...tweet('202', T3), author_id: '777001' }, ...state.mentions];
    state.now = new Date('2026-08-12T17:00:00.000Z');
    const second = await adapter.listChangesSince('mentions', first.cursor);
    expect(second.records.map((r) => r.id)).toEqual(['202']);

    state.now = new Date('2026-08-12T18:00:00.000Z');
    state.requests.length = 0;
    const gated = await adapter.listChangesSince('mentions', second.cursor);
    expect(gated.records).toEqual([]);
    expect(gated.cursor).toEqual(second.cursor);
    expect(state.requests).toEqual([]);
  });
});

describe('XPostsAdapter stats scope', () => {
  it('fetches once per interval, keyed to a stable per-day recordId', async () => {
    const { adapter, state } = await readyAdapter();
    state.profile = {
      id: USER_ID,
      username: USERNAME,
      public_metrics: { followers_count: 10, following_count: 5, tweet_count: 3 },
    };

    const day = localDayOf(state.now);
    const first = await adapter.listChangesSince('stats', undefined);
    expect(first.records.map((r) => r.id)).toEqual([`stats-${day}`]);
    expect(first.cursor).toEqual({ lastFetchAt: '2026-08-12T12:00:00.000Z', lastDay: day });

    const record = await adapter.fetchRecord('stats', first.records[0]!);
    expect(record.recordId).toBe(`stats-${day}`);
    expect(record.frontmatter.followers).toBe('10');
    expect(record.frontmatter.following).toBe('5');
    expect(record.frontmatter.posts_count).toBe('3');

    // One hour later (interval 6h): gated, cursor unchanged, no request.
    state.now = new Date('2026-08-12T13:00:00.000Z');
    state.requests.length = 0;
    const gated = await adapter.listChangesSince('stats', first.cursor);
    expect(gated.records).toEqual([]);
    expect(gated.cursor).toEqual(first.cursor);
    expect(state.requests).toEqual([]);

    // Past the interval: fetches again (same recordId within the same day —
    // the writer's content-hash refresh updates the file in place).
    state.now = new Date('2026-08-12T19:00:00.000Z');
    const refreshed = await adapter.listChangesSince('stats', first.cursor);
    expect(refreshed.records.map((r) => r.id)).toEqual([`stats-${localDayOf(state.now)}`]);
    expect((refreshed.cursor as { lastFetchAt?: string }).lastFetchAt).toBe(
      '2026-08-12T19:00:00.000Z',
    );
  });
});

describe('XPostsAdapter publish action', () => {
  it('publishes via POST /2/tweets with the bearer, returning the account-agnostic permalink without a read', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    state.publishResult = { data: { id: '1955000000000000009', text: 'hello world' } };

    const result = await adapter.runAction('publish', { text: 'hello world' });
    expect(result).toEqual({
      id: '1955000000000000009',
      permalink: 'https://x.com/i/status/1955000000000000009',
    });
    expect(state.published).toEqual([
      {
        url: 'https://api.x.com/2/tweets',
        token: 'tok-1',
        body: { text: 'hello world' },
      },
    ]);
    // The receipt permalink must never spend a paid /users/me read.
    expect(state.requests.some((u) => u.includes('/users/me'))).toBe(false);
  });

  it('threads replies through reply.in_reply_to_tweet_id', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    await adapter.runAction('publish', { text: 'following up', replyToId: '1954000000000000001' });
    expect(state.published[0]!.body).toEqual({
      text: 'following up',
      reply: { in_reply_to_tweet_id: '1954000000000000001' },
    });
  });

  it('rejects drafts past 280 code points, noting X weighs URLs as 23 chars', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    await expect(adapter.runAction('publish', { text: 'a'.repeat(281) })).rejects.toThrow(
      /limited to 280 characters.*281.*URL.*23/s,
    );
    expect(state.published).toEqual([]);
    // Code points, not UTF-16 units: 280 emoji (560 UTF-16 units) still pass.
    await adapter.runAction('publish', { text: '\u{1F4A1}'.repeat(280) });
    expect(state.published).toHaveLength(1);
  });

  it('refuses when allowPublish is off (the default), before any network call', async () => {
    const { adapter, state } = await readyAdapter();
    await expect(adapter.runAction('publish', { text: 'hi' })).rejects.toThrow(
      /Publishing is disabled.*Allow publishing/,
    );
    expect(state.published).toEqual([]);
    await expect(adapter.runAction('delete-post', {})).rejects.toThrow(
      /declares no action 'delete-post'/,
    );
  });

  it('requires non-empty post text and an object input', async () => {
    const { adapter } = await readyAdapter({ allowPublish: true });
    await expect(adapter.runAction('publish', { text: '   ' })).rejects.toThrow(
      /non-empty post text/,
    );
    await expect(adapter.runAction('publish', 'hi')).rejects.toThrow(/must be an object/);
  });

  it('refreshes an expired token first and publishes with the rotated bearer', async () => {
    const { adapter, state } = await readyAdapter(
      { allowPublish: true },
      cred({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    await adapter.runAction('publish', { text: 'fresh token' });
    expect(state.refreshCalls).toHaveLength(1);
    expect(state.published[0]!.token).toBe('tok-2');
  });
});

describe('XPostsAdapter metrics history', () => {
  it('emits one prebuilt per-day record per observed post, for new fetches and re-walks alike', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter();
    state.timeline = [tweet('103', T3), tweet('102', T2)];

    const first = await adapter.listChangesSince('posts', undefined);
    expect(first.records.map((r) => r.id)).toEqual([
      '103',
      '102',
      'metrics:103:2026-08-12',
      'metrics:102:2026-08-12',
    ]);
    const ref = first.records.find((r) => r.id === 'metrics:103:2026-08-12')!;
    expect(ref.ordinalKey).toBe(Date.parse('2026-08-12T12:00:00.000Z'));

    const record = await adapter.fetchRecord('posts', ref);
    expect(record.recordId).toBe('metrics:103:2026-08-12');
    expect(record.dirSegments).toEqual(['metrics-history', '2026-08']);
    expect(record.quarantineLabel).toBe('Metrics reading');
    expect(record.frontmatter).toMatchObject({
      platform: 'x',
      post_id: '103',
      permalink: `https://x.com/${USERNAME}/status/103`,
      likes: '3',
      reposts: '1',
      replies: '2',
      quotes: '0',
      bookmarks: '0',
      views: '50',
    });

    // Next day (metrics refresh due): the re-walk re-observes both posts
    // under the NEW day's recordIds — one row per (post, day).
    state.now = new Date('2026-08-13T13:00:00.000Z');
    const nextPass = await makeAdapter();
    const second = await nextPass.listChangesSince('posts', first.cursor);
    expect(second.records.map((r) => r.id)).toEqual([
      '103',
      '102',
      'metrics:103:2026-08-13',
      'metrics:102:2026-08-13',
    ]);
  });

  it('re-observing the same post on the same day keeps the recordId stable', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter({
      syncIntervalHours: 1,
      metricsRefreshHours: 1,
    });
    state.timeline = [tweet('103', T3)];
    const first = await adapter.listChangesSince('posts', undefined);

    state.now = new Date('2026-08-12T14:00:00.000Z');
    const nextPass = await makeAdapter();
    const second = await nextPass.listChangesSince('posts', first.cursor);
    const metricIds = second.records.filter((r) => r.id.startsWith('metrics:')).map((r) => r.id);
    expect(metricIds).toEqual(['metrics:103:2026-08-12']);
  });

  it('is gated off by metricsHistory: false', async () => {
    const { adapter, state } = await readyAdapter({ metricsHistory: false });
    state.timeline = [tweet('103', T3)];
    const batch = await adapter.listChangesSince('posts', undefined);
    expect(batch.records.map((r) => r.id)).toEqual(['103']);
  });

  it('budgets history rows to the pass limit so posts are never displaced past the engine cap', async () => {
    const { adapter, state } = await readyAdapter();
    state.timeline = [tweet('103', T3), tweet('102', T2), tweet('101', T1)];

    const roomForOne = await adapter.listChangesSince('posts', undefined, { limit: 4 });
    expect(roomForOne.records.map((r) => r.id)).toEqual([
      '103',
      '102',
      '101',
      'metrics:103:2026-08-12',
    ]);

    const noRoom = await adapter.listChangesSince('posts', undefined, { limit: 3 });
    expect(noRoom.records.map((r) => r.id)).toEqual(['103', '102', '101']);
  });
});
