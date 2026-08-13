import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import {
  InstagramApiError,
  InstagramMediaAdapter,
  type InstagramRuntime,
} from './instagram-media.js';

const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'ig-1', type: 'instagram-media', config };
}

function cred(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: 'ig-tok-1',
    // ~34 days past the harness clock: comfortably outside the 7-day margin.
    expiresAt: '2026-09-15T00:00:00.000Z',
    refreshMode: 'long-lived-exchange',
    refreshUrl: REFRESH_URL,
    ...overrides,
  });
}

function makeDeps(initialBlob: string | null): { deps: AdapterDeps; secrets: Map<string, string> } {
  const map = new Map<string, string>();
  if (initialBlob !== null) map.set('connector-instagram-media:ig-1', initialBlob);
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

function media(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    caption: `media ${id}`,
    media_type: 'IMAGE',
    permalink: `https://www.instagram.com/p/${id}/`,
    timestamp,
    like_count: 3,
    comments_count: 1,
    ...extra,
  };
}

interface HarnessState {
  media: Record<string, unknown>[];
  profile: Record<string, unknown>;
  pageSize: number;
  now: Date;
  requests: string[];
  refreshRequests: string[];
  refreshResponse: Record<string, unknown>;
  refreshError: unknown;
  listError: unknown;
  forms: { url: string; form: Record<string, string> }[];
  containerResult: Record<string, unknown>;
  publishResult: Record<string, unknown>;
  publishError: unknown;
  permalink: string;
  permalinkError: unknown;
}

function harness(): { runtime: InstagramRuntime; state: HarnessState } {
  const state: HarnessState = {
    media: [],
    profile: { id: '17841400000000000', username: 'gezelworkshop' },
    pageSize: 2,
    now: new Date('2026-08-12T12:00:00.000Z'),
    requests: [],
    refreshRequests: [],
    refreshResponse: { access_token: 'ig-tok-2', token_type: 'bearer', expires_in: 5_184_000 },
    refreshError: undefined,
    listError: undefined,
    forms: [],
    containerResult: { id: 'CREATION-1' },
    publishResult: { id: '17900000000000009' },
    publishError: undefined,
    permalink: 'https://www.instagram.com/p/ABC123xyz/',
    permalinkError: undefined,
  };

  const runtime: InstagramRuntime = {
    getJson: async (url) => {
      state.requests.push(url);
      const u = new URL(url);
      if (u.pathname === '/refresh_access_token') {
        state.refreshRequests.push(url);
        if (state.refreshError) throw state.refreshError;
        return { ...state.refreshResponse };
      }
      if (u.pathname === '/v23.0/me/media') {
        if (state.listError) throw state.listError;
        const sorted = [...state.media].sort(
          (a, b) => Date.parse(String(b.timestamp)) - Date.parse(String(a.timestamp)),
        );
        const offset = Number(u.searchParams.get('offset') ?? '0');
        const slice = sorted.slice(offset, offset + state.pageSize);
        const nextOffset = offset + slice.length;
        let next: string | undefined;
        if (nextOffset < sorted.length) {
          const n = new URL(u.toString());
          n.searchParams.set('offset', String(nextOffset));
          next = n.toString();
        }
        return { data: slice, ...(next ? { paging: { next } } : {}) };
      }
      if (u.pathname === '/v23.0/me') {
        if (state.listError) throw state.listError;
        return { ...state.profile };
      }
      if (/^\/v23\.0\/[^/]+$/.test(u.pathname) && u.searchParams.get('fields') === 'permalink') {
        if (state.permalinkError) throw state.permalinkError;
        return { permalink: state.permalink, id: u.pathname.split('/').at(-1) };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    postForm: async (url, form) => {
      state.requests.push(url);
      state.forms.push({ url, form: { ...form } });
      const u = new URL(url);
      if (u.pathname === '/v23.0/me/media') {
        if (state.publishError) throw state.publishError;
        return { ...state.containerResult };
      }
      if (u.pathname === '/v23.0/me/media_publish') {
        return { ...state.publishResult };
      }
      throw new Error(`unexpected POST: ${url}`);
    },
    now: () => state.now,
  };
  return { runtime, state };
}

async function readyAdapter(
  config: Record<string, unknown> = {},
  blob: string | null = cred(),
): Promise<{
  adapter: InstagramMediaAdapter;
  state: HarnessState;
  secrets: Map<string, string>;
  makeAdapter: () => Promise<InstagramMediaAdapter>;
}> {
  const { runtime, state } = harness();
  const { deps, secrets } = makeDeps(blob);
  const makeAdapter = async () => {
    const a = new InstagramMediaAdapter(binding(config), deps, runtime);
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

// Meta's `+0000` timestamp format, deliberately.
const T1 = '2026-08-12T08:00:00+0000';
const T2 = '2026-08-12T09:00:00+0000';
const T3 = '2026-08-12T10:00:00+0000';
const T4 = '2026-08-12T11:00:00+0000';
const T5 = '2026-08-12T11:30:00+0000';

describe('InstagramMediaAdapter auth', () => {
  it('fails ensureAuth actionably when no credential or no access token is stored', async () => {
    const { runtime } = harness();
    const { deps } = makeDeps(null);
    const adapter = new InstagramMediaAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/No stored credential/);

    const { deps: emptyDeps } = makeDeps('{}');
    const empty = new InstagramMediaAdapter(binding(), emptyDeps, runtime);
    await expect(empty.ensureAuth()).rejects.toThrow(/no access token/);
  });

  it('refreshes the long-lived token in place once under 7 days remain, and re-persists', async () => {
    const { state, secrets } = await readyAdapter(
      {},
      cred({ expiresAt: '2026-08-14T00:00:00.000Z' }),
    );
    expect(state.refreshRequests).toHaveLength(1);
    const refreshUrl = new URL(state.refreshRequests[0]!);
    expect(refreshUrl.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(refreshUrl.searchParams.get('access_token')).toBe('ig-tok-1');

    const persisted = JSON.parse(secrets.get('connector-instagram-media:ig-1')!) as Record<
      string,
      unknown
    >;
    expect(persisted.accessToken).toBe('ig-tok-2');
    expect(persisted.refreshMode).toBe('long-lived-exchange');
    expect(persisted.refreshUrl).toBe(REFRESH_URL);
    expect(Date.parse(String(persisted.expiresAt))).toBeGreaterThan(Date.now());
  });

  it('leaves a comfortably-live token alone, and never refreshes without the exchange mode', async () => {
    const { state } = await readyAdapter();
    expect(state.refreshRequests).toEqual([]);

    const { state: legacyState } = await readyAdapter(
      {},
      cred({
        expiresAt: '2026-08-14T00:00:00.000Z',
        refreshMode: undefined,
        refreshUrl: undefined,
      }),
    );
    expect(legacyState.refreshRequests).toEqual([]);
  });

  it('surfaces a refresh failure as an actionable auth error', async () => {
    const { runtime, state } = harness();
    state.refreshError = new InstagramApiError(400, 190, 'Access token has expired');
    const { deps } = makeDeps(cred({ expiresAt: '2026-08-13T00:00:00.000Z' }));
    const adapter = new InstagramMediaAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/Instagram token refresh failed/);
  });
});

describe('InstagramMediaAdapter media scope', () => {
  it('backfills newest-first through paging.next and stops at maxMedia', async () => {
    const { adapter, state } = await readyAdapter({ maxMedia: 3 });
    state.media = [
      media('m1', T1),
      media('m2', T2),
      media('m3', T3),
      media('m4', T4),
      media('m5', T5),
    ];

    const first = await adapter.listChangesSince('media', undefined);
    expect(first.records.map((r) => r.id)).toEqual(['m5', 'm4', 'm3']);
    expect((first as { enumeratedAll?: boolean }).enumeratedAll).toBeUndefined();
    expect(first.cursor).toEqual({
      sinceTs: T5,
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
    });
    const mediaRequests = state.requests.filter((u) => u.includes('/me/media'));
    expect(mediaRequests).toHaveLength(2);
    expect(new URL(mediaRequests[0]!).searchParams.get('access_token')).toBe('ig-tok-1');
  });

  it('resumes from sinceTs with a single page, leaving older pages unwalked', async () => {
    const { adapter, state } = await readyAdapter();
    state.media = [media('m1', T1), media('m2', T2), media('m3', T3), media('m4', T4)];
    const first = await adapter.listChangesSince('media', undefined);
    // 4 media records plus their 4 metrics-history observations.
    expect(first.records).toHaveLength(8);

    state.media = [media('m5', T5), ...state.media];
    state.now = new Date('2026-08-12T13:00:00.000Z');
    state.requests.length = 0;
    const second = await adapter.listChangesSince('media', first.cursor);
    expect(second.records.map((r) => r.id)).toEqual(['m5', 'metrics:m5:2026-08-12']);
    expect(second.cursor).toEqual({
      sinceTs: T5,
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
    });
    expect(state.requests.filter((u) => u.includes('/me/media'))).toHaveLength(1);
  });

  it('re-walks the metrics window when due, refreshing counts in place and restamping', async () => {
    const { adapter, state } = await readyAdapter();
    state.media = [
      media('m5', T5),
      media('m4', T4),
      media('m3', T3),
      media('m2', T2),
      media('m1', T1),
      // Backfilled once, but outside the 30-day metrics window afterwards —
      // the re-walk must not resurface it.
      media('m0', '2026-06-01T00:00:00+0000'),
    ];
    const first = await adapter.listChangesSince('media', undefined);
    const mediaIds = (batch: { records: { id: string }[] }) =>
      batch.records.filter((r) => !r.id.startsWith('metrics:')).map((r) => r.id);
    expect(mediaIds(first)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1', 'm0']);

    // 13h later (metricsRefreshHours default 12): the walk goes back down to
    // the window floor so like/comment counts get re-observed.
    state.now = new Date('2026-08-13T01:00:00.000Z');
    const third = await adapter.listChangesSince('media', first.cursor);
    expect(mediaIds(third)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    expect(third.cursor).toEqual({
      sinceTs: T5,
      metricsRefreshedAt: '2026-08-13T01:00:00.000Z',
    });
  });

  it('stamps metrics_updated_at from the pass and maps the raw media item on fetch', async () => {
    const { adapter, state } = await readyAdapter();
    state.media = [media('m3', T3)];
    const batch = await adapter.listChangesSince('media', undefined);
    const record = await adapter.fetchRecord('media', batch.records[0]!);
    expect(record.recordId).toBe('m3');
    expect(record.frontmatter.platform).toBe('instagram');
    expect(record.frontmatter.likes).toBe('3');
    expect(record.frontmatter.metrics_updated_at).toBe('2026-08-12T12:00:00.000Z');
  });

  it('maps Meta throttle shapes (429, and body codes 4/17/32) to rateLimited, rethrowing others', async () => {
    const { adapter, state } = await readyAdapter();
    const cursor = { sinceTs: T4, metricsRefreshedAt: '2026-08-12T11:00:00.000Z' };

    for (const err of [
      new InstagramApiError(429, undefined, 'Too many requests'),
      new InstagramApiError(400, 4, 'Application request limit reached'),
      new InstagramApiError(403, 17, 'User request limit reached'),
      new InstagramApiError(400, 32, 'Page request limit reached'),
    ]) {
      state.listError = err;
      const limited = await adapter.listChangesSince('media', cursor);
      expect(limited).toEqual({ records: [], cursor, rateLimited: true });
    }

    state.listError = new InstagramApiError(400, 100, 'Unsupported get request');
    await expect(adapter.listChangesSince('media', cursor)).rejects.toThrow(/instagram api 400/);
  });
});

describe('InstagramMediaAdapter stats scope', () => {
  it('fetches once per interval, keyed to a stable per-day recordId', async () => {
    const { adapter, state } = await readyAdapter();
    state.profile = {
      id: '17841400000000000',
      username: 'gezelworkshop',
      followers_count: 2456,
      follows_count: 180,
      media_count: 74,
    };

    const day = localDayOf(state.now);
    const first = await adapter.listChangesSince('stats', undefined);
    expect(first.records.map((r) => r.id)).toEqual([`stats-${day}`]);
    expect(first.cursor).toEqual({ lastFetchAt: '2026-08-12T12:00:00.000Z', lastDay: day });

    const record = await adapter.fetchRecord('stats', first.records[0]!);
    expect(record.frontmatter.followers).toBe('2456');
    expect(record.frontmatter.following).toBe('180');
    expect(record.frontmatter.posts_count).toBe('74');

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

describe('InstagramMediaAdapter publish action', () => {
  it('publishes through the two-step container flow (create, then media_publish) with a permalink receipt', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });

    const result = await adapter.runAction('publish', {
      caption: 'New workshop shot',
      imageUrl: 'https://cdn.example.com/shot.jpg',
    });
    expect(result).toEqual({
      id: '17900000000000009',
      permalink: 'https://www.instagram.com/p/ABC123xyz/',
    });
    expect(state.forms).toEqual([
      {
        url: 'https://graph.instagram.com/v23.0/me/media',
        form: {
          image_url: 'https://cdn.example.com/shot.jpg',
          caption: 'New workshop shot',
          access_token: 'ig-tok-1',
        },
      },
      {
        url: 'https://graph.instagram.com/v23.0/me/media_publish',
        form: { creation_id: 'CREATION-1', access_token: 'ig-tok-1' },
      },
    ]);
    const receipt = state.requests.find((u) => u.includes('fields=permalink'));
    expect(receipt).toContain('/v23.0/17900000000000009');
  });

  it('treats the draft text as the caption when no explicit caption is given', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    await adapter.runAction('publish', {
      text: 'Caption from the draft flow',
      imageUrl: 'https://cdn.example.com/shot.jpg',
    });
    expect(state.forms[0]!.form.caption).toBe('Caption from the draft flow');

    await adapter.runAction('publish', {
      caption: 'Explicit caption wins',
      text: 'draft text',
      imageUrl: 'https://cdn.example.com/shot.jpg',
    });
    expect(state.forms[2]!.form.caption).toBe('Explicit caption wins');
  });

  it('rejects non-https image URLs with an instructive error, before any network call', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    await expect(
      adapter.runAction('publish', { imageUrl: 'http://cdn.example.com/shot.jpg', text: 'x' }),
    ).rejects.toThrow(/must use https/);
    await expect(
      adapter.runAction('publish', { imageUrl: 'workspace/shot.jpg', text: 'x' }),
    ).rejects.toThrow(/absolute https URL/);
    await expect(adapter.runAction('publish', { text: 'no image at all' })).rejects.toThrow(
      /requires imageUrl.*publicly hosted/s,
    );
    expect(state.forms).toEqual([]);
  });

  it('returns the media id without a permalink when the receipt read fails (best-effort)', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    state.permalinkError = new InstagramApiError(400, 100, 'Unsupported get request');
    const result = await adapter.runAction('publish', {
      caption: 'x',
      imageUrl: 'https://cdn.example.com/shot.jpg',
    });
    expect(result).toEqual({ id: '17900000000000009' });
  });

  it('refuses when allowPublish is off (the default) and rejects undeclared actions', async () => {
    const { adapter, state } = await readyAdapter();
    await expect(
      adapter.runAction('publish', { caption: 'x', imageUrl: 'https://c.example/i.jpg' }),
    ).rejects.toThrow(/Publishing is disabled.*Allow publishing/);
    expect(state.forms).toEqual([]);
    await expect(adapter.runAction('delete-media', {})).rejects.toThrow(
      /declares no action 'delete-media'/,
    );
  });

  it('refreshes a near-expiry long-lived token first and publishes with it', async () => {
    const { adapter, state } = await readyAdapter(
      { allowPublish: true },
      cred({ expiresAt: '2026-08-14T00:00:00.000Z' }),
    );
    await adapter.runAction('publish', {
      caption: 'x',
      imageUrl: 'https://cdn.example.com/shot.jpg',
    });
    expect(state.refreshRequests).toHaveLength(1);
    expect(state.forms[0]!.form.access_token).toBe('ig-tok-2');
    expect(state.forms[1]!.form.access_token).toBe('ig-tok-2');
  });
});

describe('InstagramMediaAdapter metrics history', () => {
  it('emits one prebuilt per-day record per observed media item, for new fetches and re-walks alike', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter();
    state.media = [media('m2', T2), media('m1', T1)];

    const first = await adapter.listChangesSince('media', undefined);
    expect(first.records.map((r) => r.id)).toEqual([
      'm2',
      'm1',
      'metrics:m2:2026-08-12',
      'metrics:m1:2026-08-12',
    ]);
    const ref = first.records.find((r) => r.id === 'metrics:m2:2026-08-12')!;
    expect(ref.ordinalKey).toBe(Date.parse('2026-08-12T12:00:00.000Z'));

    const record = await adapter.fetchRecord('media', ref);
    expect(record.recordId).toBe('metrics:m2:2026-08-12');
    expect(record.dirSegments).toEqual(['metrics-history', '2026-08']);
    expect(record.quarantineLabel).toBe('Metrics reading');
    expect(record.frontmatter).toMatchObject({
      platform: 'instagram',
      post_id: 'm2',
      permalink: 'https://www.instagram.com/p/m2/',
      likes: '3',
      comments: '1',
    });

    // Next day (metrics refresh due): the re-walk re-observes both items
    // under the NEW day's recordIds — one row per (post, day).
    state.now = new Date('2026-08-13T01:00:00.000Z');
    const nextPass = await makeAdapter();
    const second = await nextPass.listChangesSince('media', first.cursor);
    expect(second.records.filter((r) => r.id.startsWith('metrics:')).map((r) => r.id)).toEqual([
      'metrics:m2:2026-08-13',
      'metrics:m1:2026-08-13',
    ]);
  });

  it('re-observing the same item on the same day keeps the recordId stable', async () => {
    const { adapter, state, makeAdapter } = await readyAdapter({ metricsRefreshHours: 1 });
    state.media = [media('m1', T1)];
    const first = await adapter.listChangesSince('media', undefined);

    state.now = new Date('2026-08-12T14:00:00.000Z');
    const nextPass = await makeAdapter();
    const second = await nextPass.listChangesSince('media', first.cursor);
    const metricIds = second.records.filter((r) => r.id.startsWith('metrics:')).map((r) => r.id);
    expect(metricIds).toEqual(['metrics:m1:2026-08-12']);
  });

  it('is gated off by metricsHistory: false', async () => {
    const { adapter, state } = await readyAdapter({ metricsHistory: false });
    state.media = [media('m1', T1)];
    const batch = await adapter.listChangesSince('media', undefined);
    expect(batch.records.map((r) => r.id)).toEqual(['m1']);
  });

  it('budgets history rows to the pass limit so media are never displaced past the engine cap', async () => {
    const { adapter, state } = await readyAdapter();
    state.media = [media('m3', T3), media('m2', T2), media('m1', T1)];

    const roomForOne = await adapter.listChangesSince('media', undefined, { limit: 4 });
    expect(roomForOne.records.map((r) => r.id)).toEqual([
      'm3',
      'm2',
      'm1',
      'metrics:m3:2026-08-12',
    ]);

    const noRoom = await adapter.listChangesSince('media', undefined, { limit: 3 });
    expect(noRoom.records.map((r) => r.id)).toEqual(['m3', 'm2', 'm1']);
  });
});
