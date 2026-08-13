import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import {
  type BlueskyAgentApi,
  BlueskyPostsAdapter,
  type BlueskyRichTextResult,
  type BlueskyRuntime,
  parseAppPassword,
} from './bluesky-posts.js';

const DID = 'did:plc:testaccount123';
const HANDLE = 'tester.bsky.social';

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'bsky-1', type: 'bluesky-posts', config: { handle: HANDLE, ...config } };
}

function deps(secret: string | null = 'app-pass-1234'): AdapterDeps {
  return {
    secrets: { get: async () => secret } as unknown as SecretStore,
    store: {} as Store,
  };
}

/** Post refs vs the metrics-history refs appended after them in a batch. */
const postIds = (batch: { records: { id: string }[] }): string[] =>
  batch.records.filter((r) => !r.id.startsWith('metrics:')).map((r) => r.id);
const metricRefs = <T extends { id: string }>(batch: { records: T[] }): T[] =>
  batch.records.filter((r) => r.id.startsWith('metrics:'));

function feedPost(
  rkey: string,
  indexedAt: string,
  opts: { authorDid?: string; reason?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    post: {
      uri: `at://${opts.authorDid ?? DID}/app.bsky.feed.post/${rkey}`,
      cid: `cid-${rkey}`,
      author: { did: opts.authorDid ?? DID, handle: HANDLE },
      record: { $type: 'app.bsky.feed.post', text: `post ${rkey}`, createdAt: indexedAt },
      likeCount: 2,
      indexedAt,
    },
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
}

function notification(rkey: string, reason: string, indexedAt: string): Record<string, unknown> {
  return {
    uri: `at://did:plc:someoneelse/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: 'did:plc:someoneelse', handle: 'other.bsky.social' },
    reason,
    record: { $type: 'app.bsky.feed.post', text: `notification ${rkey}`, createdAt: indexedAt },
    isRead: false,
    indexedAt,
  };
}

interface HarnessState {
  feed: unknown[];
  notifications: unknown[];
  profile: unknown;
  postsByUri: Map<string, unknown>;
  now: Date;
  posted: Array<Record<string, unknown>>;
  uploads: Array<{ bytes: Uint8Array; encoding: string }>;
  richText: ((text: string) => BlueskyRichTextResult) | undefined;
  listError: unknown;
  feedRequests: number;
  loginArgs: { service: string; identifier: string; password: string } | undefined;
}

function harness(): { runtime: BlueskyRuntime; state: HarnessState } {
  const state: HarnessState = {
    feed: [],
    notifications: [],
    profile: {},
    postsByUri: new Map(),
    now: new Date('2026-08-12T12:00:00.000Z'),
    posted: [],
    uploads: [],
    richText: undefined,
    listError: undefined,
    feedRequests: 0,
    loginArgs: undefined,
  };
  const page = <T>(items: T[], limit: number, cursor?: string): { slice: T[]; next?: string } => {
    const start = cursor ? Number(cursor) : 0;
    const slice = items.slice(start, start + limit);
    const next = start + slice.length;
    return { slice, ...(next < items.length ? { next: String(next) } : {}) };
  };
  const agent: BlueskyAgentApi = {
    did: DID,
    getAuthorFeed: async ({ limit, cursor }) => {
      state.feedRequests += 1;
      if (state.listError) throw state.listError;
      const { slice, next } = page(state.feed, limit, cursor);
      return { feed: slice, ...(next ? { cursor: next } : {}) };
    },
    listNotifications: async ({ limit, cursor }) => {
      if (state.listError) throw state.listError;
      const { slice, next } = page(state.notifications, limit, cursor);
      return { notifications: slice, ...(next ? { cursor: next } : {}) };
    },
    getProfile: async () => state.profile,
    getPosts: async (uris) =>
      uris.map((uri) => state.postsByUri.get(uri)).filter((post) => post !== undefined),
    post: async (record) => {
      state.posted.push(record as unknown as Record<string, unknown>);
      return { uri: `at://${DID}/app.bsky.feed.post/3knewpost`, cid: 'cid-new' };
    },
    uploadBlob: async (bytes, { encoding }) => {
      state.uploads.push({ bytes, encoding });
      return { blob: { $type: 'blob', ref: `blob-${state.uploads.length}`, mimeType: encoding } };
    },
    richText: async (text) =>
      state.richText ? state.richText(text) : { text, graphemeLength: [...text].length },
  };
  const runtime: BlueskyRuntime = {
    login: async (args) => {
      state.loginArgs = args;
      return agent;
    },
    now: () => state.now,
  };
  return { runtime, state };
}

async function readyAdapter(
  config: Record<string, unknown> = {},
  secret: string | null = 'app-pass-1234',
  adapterDeps: AdapterDeps = deps(secret),
): Promise<{ adapter: BlueskyPostsAdapter; state: HarnessState }> {
  const { runtime, state } = harness();
  const adapter = new BlueskyPostsAdapter(binding(config), adapterDeps, runtime);
  await adapter.ensureAuth();
  return { adapter, state };
}

const localDayOf = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

describe('BlueskyPostsAdapter auth + scopes', () => {
  it('accepts the app password as a plain string or an {appPassword} JSON blob', async () => {
    expect(parseAppPassword('abcd-efgh-ijkl-mnop')).toBe('abcd-efgh-ijkl-mnop');
    expect(parseAppPassword('  abcd-efgh-ijkl-mnop \n')).toBe('abcd-efgh-ijkl-mnop');
    expect(parseAppPassword('{"appPassword":"wxyz-1234"}')).toBe('wxyz-1234');

    const { state } = await readyAdapter({}, '{"appPassword":"wxyz-1234"}');
    expect(state.loginArgs).toEqual({
      service: 'https://bsky.social',
      identifier: HANDLE,
      password: 'wxyz-1234',
    });
  });

  it('fails ensureAuth with an actionable message when no app password is stored', async () => {
    const { runtime } = harness();
    const adapter = new BlueskyPostsAdapter(binding(), deps(null), runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/app password/i);
  });

  it('lists scopes per config: mentions on by default, removable', async () => {
    const { adapter } = await readyAdapter();
    expect(await adapter.listScopes()).toEqual(['posts', 'mentions', 'stats']);

    const { adapter: noMentions } = await readyAdapter({ syncMentions: false });
    expect(await noMentions.listScopes()).toEqual(['posts', 'stats']);
  });
});

describe('BlueskyPostsAdapter posts scope', () => {
  const T1 = '2026-08-12T08:00:00.000Z';
  const T2 = '2026-08-12T09:00:00.000Z';
  const T3 = '2026-08-12T10:00:00.000Z';
  const T4 = '2026-08-12T11:00:00.000Z';

  it('backfills on the first pass, then resumes from the cursor with only newer posts', async () => {
    const { adapter, state } = await readyAdapter();
    state.feed = [feedPost('c', T3), feedPost('b', T2), feedPost('a', T1)];

    const first = await adapter.listChangesSince('posts', undefined);
    expect(postIds(first)).toEqual([
      `at://${DID}/app.bsky.feed.post/c`,
      `at://${DID}/app.bsky.feed.post/b`,
      `at://${DID}/app.bsky.feed.post/a`,
    ]);
    expect(first.enumeratedAll).toBeUndefined();
    expect(first.rateLimited).toBeUndefined();
    expect(first.cursor).toEqual({
      sinceTs: T3,
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
    });

    // One hour later a new post lands; the metrics refresh (6h) is not due.
    state.feed = [feedPost('d', T4), ...state.feed];
    state.now = new Date('2026-08-12T13:00:00.000Z');
    const second = await adapter.listChangesSince('posts', first.cursor);
    expect(postIds(second)).toEqual([`at://${DID}/app.bsky.feed.post/d`]);
    expect(second.cursor).toEqual({
      sinceTs: T4,
      metricsRefreshedAt: '2026-08-12T12:00:00.000Z',
    });
  });

  it('re-walks the metrics window when due, refreshing engagement in place, and restamps', async () => {
    const { adapter, state } = await readyAdapter();
    state.feed = [feedPost('c', T3), feedPost('b', T2), feedPost('a', T1)];
    const first = await adapter.listChangesSince('posts', undefined);

    state.feed = [feedPost('d', T4), ...state.feed];
    // Past the 6h refresh interval: the pass walks back down to the
    // 30-day window so counts get re-observed.
    state.now = new Date('2026-08-12T19:00:00.000Z');
    const third = await adapter.listChangesSince('posts', {
      ...(first.cursor as Record<string, unknown>),
      sinceTs: T4,
    });
    expect(postIds(third)).toEqual([
      `at://${DID}/app.bsky.feed.post/d`,
      `at://${DID}/app.bsky.feed.post/c`,
      `at://${DID}/app.bsky.feed.post/b`,
      `at://${DID}/app.bsky.feed.post/a`,
    ]);
    expect((third.cursor as { metricsRefreshedAt?: string }).metricsRefreshedAt).toBe(
      '2026-08-12T19:00:00.000Z',
    );
    expect((third.cursor as { sinceTs?: string }).sinceTs).toBe(T4);
  });

  it('leaves posts older than the metrics window untouched by the re-walk', async () => {
    const { adapter, state } = await readyAdapter({ metricsWindowDays: 30 });
    const OLD = '2026-06-01T00:00:00.000Z';
    state.feed = [feedPost('c', T3), feedPost('old', OLD)];
    const first = await adapter.listChangesSince('posts', undefined);
    expect(postIds(first)).toHaveLength(2);

    state.now = new Date('2026-08-12T19:00:00.000Z');
    const next = await adapter.listChangesSince('posts', first.cursor);
    expect(postIds(next)).toEqual([`at://${DID}/app.bsky.feed.post/c`]);
  });

  it('skips reposts but still advances the high-water past them', async () => {
    const { adapter, state } = await readyAdapter();
    const REPOST_AT = '2026-08-12T11:30:00.000Z';
    state.feed = [
      feedPost('x', T1, {
        authorDid: 'did:plc:originalauthor',
        reason: { $type: 'app.bsky.feed.defs#reasonRepost', indexedAt: REPOST_AT },
      }),
      feedPost('b', T2),
    ];
    const batch = await adapter.listChangesSince('posts', undefined);
    expect(postIds(batch)).toEqual([`at://${DID}/app.bsky.feed.post/b`]);
    expect((batch.cursor as { sinceTs?: string }).sinceTs).toBe(REPOST_AT);
  });

  it('stamps metrics_updated_at from the pass and maps the raw feed item on fetch', async () => {
    const { adapter, state } = await readyAdapter();
    state.feed = [feedPost('c', T3)];
    const batch = await adapter.listChangesSince('posts', undefined);
    const record = await adapter.fetchRecord('posts', batch.records[0]!);
    expect(record.recordId).toBe(`at://${DID}/app.bsky.feed.post/c`);
    expect(record.frontmatter.metrics_updated_at).toBe('2026-08-12T12:00:00.000Z');
    expect(record.frontmatter.likes).toBe('2');
  });

  it('returns a rateLimited batch with the cursor kept on 429, and rethrows other faults', async () => {
    const { adapter, state } = await readyAdapter();
    state.listError = Object.assign(new Error('Rate Limit Exceeded'), { status: 429 });
    const cursor = { sinceTs: T3, metricsRefreshedAt: T3 };
    const limited = await adapter.listChangesSince('posts', cursor);
    expect(limited).toEqual({ records: [], cursor, rateLimited: true });

    state.listError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    await expect(adapter.listChangesSince('posts', cursor)).rejects.toThrow(
      /Internal Server Error/,
    );
  });
});

describe('BlueskyPostsAdapter metrics history', () => {
  const T1 = '2026-08-12T08:00:00.000Z';
  const T2 = '2026-08-12T09:00:00.000Z';
  const T3 = '2026-08-12T10:00:00.000Z';
  const URI_B = `at://${DID}/app.bsky.feed.post/b`;
  const URI_C = `at://${DID}/app.bsky.feed.post/c`;

  it('emits a day-0 observation ref per new post, prebuilt and passed through fetchRecord', async () => {
    const { adapter, state } = await readyAdapter();
    state.feed = [feedPost('c', T3), feedPost('b', T2)];

    const batch = await adapter.listChangesSince('posts', undefined);
    const refs = metricRefs(batch);
    expect(refs.map((r) => r.id)).toEqual([
      `metrics:${URI_C}:2026-08-12`,
      `metrics:${URI_B}:2026-08-12`,
    ]);
    // Observation-time ordinal so the engine's newest-first cap keeps them.
    expect(refs[0]?.ordinalKey).toBe(Date.parse('2026-08-12T12:00:00.000Z'));

    const record = await adapter.fetchRecord('posts', refs[0]!);
    expect(record.recordId).toBe(`metrics:${URI_C}:2026-08-12`);
    expect(record.dirSegments).toEqual(['metrics-history', '2026-08']);
    expect(record.frontmatter).toEqual({
      title: 'Engagement on 2026-08-12: post c',
      date: '2026-08-12T12:00:00.000Z',
      platform: 'bluesky',
      post_id: URI_C,
      permalink: `https://bsky.app/profile/${HANDLE}/post/c`,
      likes: '2',
    });
    // The observation stamp matches the post's metrics_updated_at.
    const post = await adapter.fetchRecord('posts', batch.records.find((r) => r.id === URI_C)!);
    expect(post.frontmatter.metrics_updated_at).toBe(record.frontmatter.date);
  });

  it('re-observes re-walked posts: same-day passes share a recordId, a new day appends', async () => {
    const { adapter, state } = await readyAdapter();
    state.feed = [feedPost('c', T3)];
    const first = await adapter.listChangesSince('posts', undefined);
    expect(metricRefs(first).map((r) => r.id)).toEqual([`metrics:${URI_C}:2026-08-12`]);

    // Second pass the same day (past the 6h refresh): construct-per-pass
    // means a fresh ensureAuth restamps the pass timestamp.
    state.now = new Date('2026-08-12T19:00:00.000Z');
    await adapter.ensureAuth();
    const sameDay = await adapter.listChangesSince('posts', first.cursor);
    expect(postIds(sameDay)).toEqual([URI_C]);
    expect(metricRefs(sameDay).map((r) => r.id)).toEqual([`metrics:${URI_C}:2026-08-12`]);

    // Next-day pass: a new per-day record.
    state.now = new Date('2026-08-13T07:00:00.000Z');
    await adapter.ensureAuth();
    const nextDay = await adapter.listChangesSince('posts', sameDay.cursor);
    expect(metricRefs(nextDay).map((r) => r.id)).toEqual([`metrics:${URI_C}:2026-08-13`]);
  });

  it('emits nothing when metricsHistory is disabled', async () => {
    const { adapter, state } = await readyAdapter({ metricsHistory: false });
    state.feed = [feedPost('c', T3), feedPost('a', T1)];
    const first = await adapter.listChangesSince('posts', undefined);
    expect(metricRefs(first)).toEqual([]);
    expect(first.records.map((r) => r.id)).toEqual([
      `at://${DID}/app.bsky.feed.post/c`,
      `at://${DID}/app.bsky.feed.post/a`,
    ]);
  });
});

describe('BlueskyPostsAdapter mentions scope', () => {
  it('filters to mention/reply/quote and resumes from the notification high-water', async () => {
    const { adapter, state } = await readyAdapter();
    state.notifications = [
      notification('l1', 'like', '2026-08-12T11:00:00.000Z'),
      notification('m1', 'mention', '2026-08-12T10:00:00.000Z'),
      notification('r1', 'reply', '2026-08-12T09:00:00.000Z'),
      notification('f1', 'follow', '2026-08-12T08:00:00.000Z'),
      notification('q1', 'quote', '2026-08-12T07:00:00.000Z'),
    ];
    const first = await adapter.listChangesSince('mentions', undefined);
    expect(first.records.map((r) => r.id)).toEqual([
      'at://did:plc:someoneelse/app.bsky.feed.post/m1',
      'at://did:plc:someoneelse/app.bsky.feed.post/r1',
      'at://did:plc:someoneelse/app.bsky.feed.post/q1',
    ]);
    expect(first.enumeratedAll).toBeUndefined();
    // The high-water tracks every scanned notification, likes included, so
    // the next pass stops immediately at anything already seen.
    expect(first.cursor).toEqual({ sinceTs: '2026-08-12T11:00:00.000Z' });

    state.notifications = [
      notification('m2', 'mention', '2026-08-12T12:30:00.000Z'),
      ...state.notifications,
    ];
    const second = await adapter.listChangesSince('mentions', first.cursor);
    expect(second.records.map((r) => r.id)).toEqual([
      'at://did:plc:someoneelse/app.bsky.feed.post/m2',
    ]);
    const record = await adapter.fetchRecord('mentions', second.records[0]!);
    expect(record.frontmatter.reason).toBe('mention');
    expect(record.frontmatter.author).toBe('other.bsky.social');
  });
});

describe('BlueskyPostsAdapter stats scope', () => {
  it('fetches once per interval, keyed to a stable per-day recordId', async () => {
    const { adapter, state } = await readyAdapter();
    state.profile = { handle: HANDLE, followersCount: 10, followsCount: 5, postsCount: 3 };

    const day = localDayOf(state.now);
    const first = await adapter.listChangesSince('stats', undefined);
    expect(first.records.map((r) => r.id)).toEqual([`stats-${day}`]);
    expect(first.enumeratedAll).toBeUndefined();
    expect(first.cursor).toEqual({ lastFetchAt: '2026-08-12T12:00:00.000Z', lastDay: day });

    const record = await adapter.fetchRecord('stats', first.records[0]!);
    expect(record.recordId).toBe(`stats-${day}`);
    expect(record.frontmatter.followers).toBe('10');
    expect(record.frontmatter.following).toBe('5');
    expect(record.frontmatter.posts_count).toBe('3');

    // One hour later (interval 6h): gated, cursor unchanged.
    state.now = new Date('2026-08-12T13:00:00.000Z');
    const gated = await adapter.listChangesSince('stats', first.cursor);
    expect(gated.records).toEqual([]);
    expect(gated.cursor).toEqual(first.cursor);

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

describe('BlueskyPostsAdapter publish action', () => {
  it('publishes with detected facets, langs, and resolved reply threading', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    const facets = [{ index: { byteStart: 6, byteEnd: 20 }, features: [] }];
    state.richText = (text) => ({ text, facets, graphemeLength: [...text].length });
    const parentUri = 'at://did:plc:parentauthor/app.bsky.feed.post/3kparent';
    state.postsByUri.set(parentUri, {
      uri: parentUri,
      cid: 'cid-parent',
      record: {
        reply: {
          root: { uri: 'at://did:plc:rootauthor/app.bsky.feed.post/3kroot', cid: 'cid-root' },
        },
      },
    });

    const result = (await adapter.runAction('publish', {
      text: 'hello @other.bsky.social',
      langs: ['en'],
      replyToUri: parentUri,
    })) as { uri: string; cid: string; permalink: string };

    expect(result).toEqual({
      uri: `at://${DID}/app.bsky.feed.post/3knewpost`,
      cid: 'cid-new',
      permalink: `https://bsky.app/profile/${HANDLE}/post/3knewpost`,
    });
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]).toEqual({
      text: 'hello @other.bsky.social',
      facets,
      langs: ['en'],
      reply: {
        root: { uri: 'at://did:plc:rootauthor/app.bsky.feed.post/3kroot', cid: 'cid-root' },
        parent: { uri: parentUri, cid: 'cid-parent' },
      },
      createdAt: '2026-08-12T12:00:00.000Z',
    });
  });

  it('treats a parent that is not itself a reply as the thread root', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    const parentUri = 'at://did:plc:parentauthor/app.bsky.feed.post/3ktop';
    state.postsByUri.set(parentUri, { uri: parentUri, cid: 'cid-top', record: {} });

    await adapter.runAction('publish', { text: 'replying', replyToUri: parentUri });
    expect(state.posted[0]?.reply).toEqual({
      root: { uri: parentUri, cid: 'cid-top' },
      parent: { uri: parentUri, cid: 'cid-top' },
    });
  });

  it('rejects a draft over the 300-grapheme limit without posting', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    state.richText = (text) => ({ text, graphemeLength: 301 });
    await expect(adapter.runAction('publish', { text: 'x'.repeat(400) })).rejects.toThrow(
      /limited to 300 characters; this draft is 301/,
    );
    expect(state.posted).toEqual([]);
  });

  it('refuses to publish when the binding has not enabled publishing', async () => {
    const { adapter, state } = await readyAdapter();
    await expect(adapter.runAction('publish', { text: 'hi' })).rejects.toThrow(
      /Publishing is disabled/,
    );
    expect(state.posted).toEqual([]);
  });

  it('requires non-empty text and rejects undeclared actions', async () => {
    const { adapter } = await readyAdapter({ allowPublish: true });
    await expect(adapter.runAction('publish', { text: '   ' })).rejects.toThrow(
      /non-empty post text/,
    );
    await expect(adapter.runAction('delete-post', {})).rejects.toThrow(
      /declares no action 'delete-post'/,
    );
  });
});

describe('BlueskyPostsAdapter publish images', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function imageProject(): Promise<{
    adapterDeps: AdapterDeps;
    artifactsDir: string;
    workspaceDir: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'gezel-bsky-images-'));
    roots.push(root);
    const artifactsDir = join(root, 'artifacts');
    const workspaceDir = join(root, 'workspace');
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    const adapterDeps: AdapterDeps = {
      secrets: { get: async () => 'app-pass-1234' } as unknown as SecretStore,
      store: {
        projectArtifactsDir: () => artifactsDir,
        projectWorkspaceDir: async () => workspaceDir,
      } as unknown as Store,
      projectId: 'p1',
    };
    return { adapterDeps, artifactsDir, workspaceDir };
  }

  async function put(base: string, rel: string, content: string | Uint8Array): Promise<void> {
    const abs = join(base, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  it('uploads each image with its extension mime and attaches the embed to the post', async () => {
    const { adapterDeps, artifactsDir, workspaceDir } = await imageProject();
    await put(artifactsDir, 'shots/connector.png', 'png-bytes');
    await put(workspaceDir, 'docs/diagram.jpg', 'jpg-bytes');
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await adapter.runAction('publish', {
      text: 'With pictures',
      images: [
        { path: 'shots/connector.png', alt: 'Connector settings page' },
        { path: 'docs/diagram.jpg' },
      ],
    });

    expect(state.uploads.map((u) => u.encoding)).toEqual(['image/png', 'image/jpeg']);
    expect(Buffer.from(state.uploads[0]!.bytes).toString('utf8')).toBe('png-bytes');
    expect(Buffer.from(state.uploads[1]!.bytes).toString('utf8')).toBe('jpg-bytes');
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]?.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: { $type: 'blob', ref: 'blob-1', mimeType: 'image/png' },
          alt: 'Connector settings page',
        },
        // Alt defaults to empty; draft_post nudges the model to supply it.
        { image: { $type: 'blob', ref: 'blob-2', mimeType: 'image/jpeg' }, alt: '' },
      ],
    });
  });

  it('resolves against artifacts before the workspace when both hold the path', async () => {
    const { adapterDeps, artifactsDir, workspaceDir } = await imageProject();
    await put(artifactsDir, 'pic.png', 'artifact-copy');
    await put(workspaceDir, 'pic.png', 'workspace-copy');
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await adapter.runAction('publish', { text: 'order', images: [{ path: 'pic.png', alt: 'p' }] });
    expect(Buffer.from(state.uploads[0]!.bytes).toString('utf8')).toBe('artifact-copy');
  });

  it('falls back to the workspace when the image is not under artifacts', async () => {
    const { adapterDeps, workspaceDir } = await imageProject();
    await put(workspaceDir, 'only-here.webp', 'workspace-webp');
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await adapter.runAction('publish', {
      text: 'fallback',
      images: [{ path: 'only-here.webp', alt: 'w' }],
    });
    expect(state.uploads.map((u) => u.encoding)).toEqual(['image/webp']);
    expect(Buffer.from(state.uploads[0]!.bytes).toString('utf8')).toBe('workspace-webp');
  });

  it('rejects more than 4 images and entries without a path, before any upload', async () => {
    const { adapterDeps } = await imageProject();
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    const five = Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.png` }));
    await expect(adapter.runAction('publish', { text: 'too many', images: five })).rejects.toThrow(
      /at most 4 images; this draft attaches 5/,
    );
    await expect(
      adapter.runAction('publish', { text: 'no path', images: [{ alt: 'missing path' }] }),
    ).rejects.toThrow(/images\[0\] needs a string path/);
    expect(state.uploads).toEqual([]);
    expect(state.posted).toEqual([]);
  });

  it('rejects an oversized image, naming the file and its size, without uploading', async () => {
    const { adapterDeps, artifactsDir } = await imageProject();
    await put(artifactsDir, 'big.png', new Uint8Array(1_000_001));
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await expect(
      adapter.runAction('publish', { text: 'big', images: [{ path: 'big.png', alt: 'big' }] }),
    ).rejects.toThrow(/big\.png is 1000001 bytes; Bluesky's limit is 1000000 bytes/);
    expect(state.uploads).toEqual([]);
    expect(state.posted).toEqual([]);
  });

  it('rejects unsupported image extensions even when the file exists', async () => {
    const { adapterDeps, artifactsDir } = await imageProject();
    await put(artifactsDir, 'scan.tiff', 'tiff-bytes');
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await expect(
      adapter.runAction('publish', { text: 'scan', images: [{ path: 'scan.tiff', alt: 's' }] }),
    ).rejects.toThrow(/Unsupported image type for scan\.tiff/);
    expect(state.uploads).toEqual([]);
  });

  it('rejects traversal paths outright and reports a missing image with the search order', async () => {
    const { adapterDeps } = await imageProject();
    const { adapter, state } = await readyAdapter({ allowPublish: true }, null, adapterDeps);

    await expect(
      adapter.runAction('publish', { text: 'sneaky', images: [{ path: '../outside.png' }] }),
    ).rejects.toThrow(/escapes the project directories/);

    await expect(
      adapter.runAction('publish', { text: 'missing', images: [{ path: 'nope.png' }] }),
    ).rejects.toThrow(/Image not found: nope\.png.*artifacts directory first, then its workspace/);
    expect(state.uploads).toEqual([]);
    expect(state.posted).toEqual([]);
  });
});
