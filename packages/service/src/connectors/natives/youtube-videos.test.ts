import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { FakeHttp, json, status } from '../testing/fake-http.js';
import {
  FAKE_YOUTUBE_KEY,
  type FakeVideo,
  FakeYouTube,
  apiKeyInvalid,
  quotaExceeded,
} from '../testing/fake-youtube.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { ConnectorBindingRef } from '../types.js';
import {
  YOUTUBE_API_BASE,
  YouTubeVideosAdapter,
  isoDurationSeconds,
  parseChannelSpec,
  redactApiKey,
} from './youtube-videos.js';

const BENCH = 'UCq7nB5Wd3Bh3H3l2o0bDqGw';
const KITCHEN = 'UCk1tchenK1tchenK1tchen0';
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

function video(n: number, extra: Partial<FakeVideo> = {}): FakeVideo {
  return {
    id: `vid${String(n).padStart(8, '0')}`,
    title: `Video number ${n}`,
    description: `Description of video ${n}.`,
    publishedAt: new Date(T0 - (50 - n) * 3_600_000).toISOString(),
    duration: 'PT12M5S',
    views: 100 * n,
    likes: 10 * n,
    comments: n,
    ...extra,
  };
}

function binding(channels: string[], extra: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'yt-1', type: 'youtube-videos', config: { channels, ...extra } };
}

function seedWorld(): { http: FakeHttp; yt: FakeYouTube } {
  const http = new FakeHttp();
  const yt = new FakeYouTube()
    .channel({
      id: BENCH,
      handle: '@WorkshopBench',
      title: 'Workshop Bench',
      videos: [video(3), video(2), video(1)],
    })
    .channel({ id: KITCHEN, title: 'Kitchen', videos: [video(12), video(11)] })
    .install(http);
  return { http, yt };
}

describeConnectorConformance('youtube-videos', {
  async create() {
    const env = await createConnectorTestEnv();
    const { http, yt } = seedWorld();
    let now = T0;
    const b = binding(['@workshopbench', KITCHEN], { syncIntervalHours: 0 });
    await env.storeCredential(b, FAKE_YOUTUBE_KEY);
    let next = 20;
    return {
      env,
      seeded: 5,
      requiredKeys: ['title', 'date', 'url', 'video_id', 'channel'],
      unrouted: () => http.unrouted,
      adapter: async () =>
        new YouTubeVideosAdapter(b, env.deps({ fetch: http.fetch }), { now: () => new Date(now) }),
      hooks: {
        add: (n = 1) => {
          for (let i = 0; i < n; i++)
            yt.upload(BENCH, video(next++, { publishedAt: new Date(now).toISOString() }));
        },
        // Edits surface on the next count refresh, so the clock moves past it.
        update: () => {
          yt.updateVideo(video(2).id, { title: 'Video number 2 (re-edited)' });
          now += 25 * 3_600_000;
        },
        throttleNextList: () => {
          http.failNext({ url: `${YOUTUBE_API_BASE}/playlistItems` }, quotaExceeded());
        },
        revokeAuth: () => {
          yt.revokeKeys();
        },
        addHostile: () => {
          yt.upload(
            BENCH,
            video(99, {
              title: HOSTILE_NAME,
              description: INJECTION_PAYLOAD,
              publishedAt: new Date(now).toISOString(),
            }),
          );
        },
      },
    };
  },
});

// ── adapter behavior ───────────────────────────────────────────────────────

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

async function world(config: Record<string, unknown> = {}, channels = ['@workshopbench']) {
  env = await createConnectorTestEnv();
  const e = env;
  const { http, yt } = seedWorld();
  const clock = { now: T0 };
  const b = binding(channels, config);
  await e.storeCredential(b, FAKE_YOUTUBE_KEY);
  let cursor: unknown;
  const adapter = () =>
    new YouTubeVideosAdapter(b, e.deps({ fetch: http.fetch }), { now: () => new Date(clock.now) });
  const pass = async (backfillLimit = 500) => {
    const r = await syncWithAdapter(adapter(), {
      storageDir: e.artifactsDir,
      quarantineDir: e.quarantineDir,
      corpusDir: 'data/yt',
      backfillLimit,
      cursor,
    });
    cursor = r.cursor;
    return r;
  };
  const scopeCursor = (scope: string) =>
    (cursor as { scopes: Record<string, Record<string, unknown>> }).scopes[scope];
  return {
    http,
    yt,
    clock,
    adapter,
    pass,
    scopeCursor,
    corpus: () => readCorpus(e.artifactsDir, 'data/yt'),
    resources: () => yt.calls.map((c) => c.resource),
  };
}

describe('youtube-videos channel resolution', () => {
  it('resolves a handle once with forHandle and pins the channel in the cursor', async () => {
    const w = await world({ syncIntervalHours: 0 });
    const first = await w.pass();
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(3);
    const lookup = w.yt.calls.find((c) => c.resource === 'channels')!;
    expect(lookup.query.get('forHandle')).toBe('@workshopbench');
    expect(lookup.query.get('part')).toBe('snippet,contentDetails');
    expect(w.scopeCursor('@workshopbench')).toMatchObject({
      channelId: BENCH,
      uploads: `UU${BENCH.slice(2)}`,
      title: 'Workshop Bench',
    });
    w.yt.calls.length = 0;
    await w.pass();
    expect(w.resources()).toEqual(['playlistItems']);
  });

  it('accepts channel URLs, ids and handles, and refuses what the API cannot look up', () => {
    expect(parseChannelSpec(`https://www.youtube.com/channel/${BENCH}`)).toEqual({
      kind: 'id',
      value: BENCH,
    });
    expect(parseChannelSpec('youtube.com/@WorkshopBench/videos')).toEqual({
      kind: 'handle',
      value: '@workshopbench',
    });
    expect(parseChannelSpec('WorkshopBench')).toEqual({ kind: 'handle', value: '@workshopbench' });
    expect(parseChannelSpec('https://www.youtube.com/user/oldname')).toEqual({
      kind: 'username',
      value: 'oldname',
    });
    expect(parseChannelSpec('https://www.youtube.com/c/SomeCustom')).toMatchObject({
      error: expect.stringMatching(/custom channel URL/),
    });
    expect(parseChannelSpec('not a channel!')).toMatchObject({ error: expect.any(String) });
  });

  it('an unknown channel fails its scope while the others sync', async () => {
    const w = await world({}, ['@nobody-here', KITCHEN]);
    const r = await w.pass();
    expect(r.error).toBeUndefined();
    expect(r.errors).toBe(1);
    expect(r.written).toBe(2);
    expect(r.failedScopes).toEqual([
      {
        scope: '@nobody-here',
        message: expect.stringMatching(/YouTube has no channel for @nobody-here/),
      },
    ]);
  });

  it('with a single channel the reason is the pass error', async () => {
    const w = await world({}, ['@nobody-here']);
    expect((await w.pass()).error).toMatch(/YouTube has no channel for @nobody-here/);
  });
});

describe('youtube-videos walking the uploads', () => {
  it('stops at the newest video it already has and fetches only the new ones', async () => {
    const w = await world({ syncIntervalHours: 0 });
    await w.pass();
    w.yt.upload(BENCH, video(4)).upload(BENCH, video(5));
    w.yt.calls.length = 0;
    const r = await w.pass();
    expect(r.written).toBe(2);
    expect(w.resources()).toEqual(['playlistItems', 'videos']);
    expect(w.yt.calls[1]!.query.get('id')).toBe(`${video(5).id},${video(4).id}`);
  });

  it('a pass inside the sync interval makes no requests', async () => {
    const w = await world({ syncIntervalHours: 6 });
    await w.pass();
    w.yt.upload(BENCH, video(4));
    w.yt.calls.length = 0;
    expect((await w.pass()).written).toBe(0);
    expect(w.yt.calls).toHaveLength(0);
    w.clock.now += 6 * 3_600_000;
    expect((await w.pass()).written).toBe(1);
  });

  it('batches videos.list by 50 and pages the playlist, one quota unit per call', async () => {
    const w = await world({ syncIntervalHours: 0 });
    for (let n = 4; n <= 120; n++)
      w.yt.upload(BENCH, video(n % 50, { id: `bulk${String(n).padStart(7, '0')}` }));
    const r = await w.pass();
    expect(r.written).toBe(120);
    const videoCalls = w.yt.calls.filter((c) => c.resource === 'videos');
    expect(videoCalls.map((c) => c.query.get('id')!.split(',').length)).toEqual([50, 50, 20]);
    expect(w.yt.calls.filter((c) => c.resource === 'playlistItems')).toHaveLength(3);
    expect(w.yt.quotaUsed).toBe(1 + 3 + 3);
    for (const c of w.yt.calls)
      expect(Number(c.query.get('maxResults') ?? '0')).toBeLessThanOrEqual(50);
  });

  it('caps the backfill at maxVideos', async () => {
    const w = await world({ maxVideos: 2 });
    const r = await w.pass();
    expect(r.written).toBe(2);
    const titles = (await w.corpus()).map((x) => x.frontmatter.title).sort();
    expect(titles).toEqual(['Video number 2', 'Video number 3']);
  });

  it('a walk cut short by the per-pass limit resumes from its page token', async () => {
    const w = await world({ syncIntervalHours: 0 });
    for (let n = 4; n <= 9; n++) w.yt.upload(BENCH, video(n));
    const r = await w.pass(2);
    // 9 videos at 2 per round, 4 rounds per pass.
    expect(r.written).toBe(8);
    expect(w.scopeCursor('@workshopbench')!.walk).toBeTruthy();
    const rest = await w.pass(2);
    expect(rest.written).toBe(1);
    expect(w.scopeCursor('@workshopbench')!.walk).toBeUndefined();
    expect(await w.corpus()).toHaveLength(9);
    w.yt.calls.length = 0;
    expect((await w.pass(2)).written).toBe(0);
    expect(w.resources()).toEqual(['playlistItems']);
  });

  it('restarts a resumed walk whose page token went stale', async () => {
    const w = await world({ syncIntervalHours: 0 });
    for (let n = 4; n <= 9; n++) w.yt.upload(BENCH, video(n));
    await w.pass(1);
    const cursor = w.scopeCursor('@workshopbench')! as { walk: { pageToken: string } };
    cursor.walk.pageToken = 'garbage-token';
    const r = await w.pass(500);
    expect(r.errors).toBe(0);
    expect(await w.corpus()).toHaveLength(9);
  });

  it('skips a video made private between the playlist read and the lookup', async () => {
    const w = await world();
    const http = w.http;
    http.on('GET', `${YOUTUBE_API_BASE}/videos`, (req) => {
      const ids = (req.url.searchParams.get('id') ?? '').split(',');
      expect(ids).toHaveLength(3);
      return json({ kind: 'youtube#videoListResponse', items: [] });
    });
    const r = await w.pass();
    expect(r.errors).toBe(0);
    expect(r.written).toBe(0);
  });
});

describe('youtube-videos counts', () => {
  it('refreshes counts only for videos inside the window, at most once per refresh period', async () => {
    // Videos 2 and 3 are ~2 days old: inside a 4-day window even a day later.
    const w = await world({ syncIntervalHours: 0, metricsWindowDays: 4 });
    w.yt.updateVideo(video(1).id, { publishedAt: '2026-09-01T00:00:00.000Z' });
    await w.pass();
    w.yt.updateVideo(video(3).id, { views: 99_999 });
    w.yt.updateVideo(video(1).id, { views: 77_777 });
    w.yt.calls.length = 0;
    expect((await w.pass()).written).toBe(0);
    w.clock.now += 25 * 3_600_000;
    w.yt.calls.length = 0;
    const refreshed = await w.pass();
    const lookups = w.yt.calls.filter((c) => c.resource === 'videos');
    expect(lookups.map((c) => c.query.get('id'))).toEqual([`${video(3).id},${video(2).id}`]);
    // Both were re-read, but only video 3's counts moved; a refresh that would
    // change nothing but `metrics_updated_at` is not a rewrite (volatileKeys).
    expect(refreshed.written).toBe(1);
    const byTitle = Object.fromEntries(
      (await w.corpus()).map((x) => [x.frontmatter.title, x.frontmatter]),
    );
    expect(byTitle['Video number 3']!.views).toBe('99999');
    expect(byTitle['Video number 3']!.metrics_updated_at).toBe(new Date(w.clock.now).toISOString());
    expect(byTitle['Video number 1']!.views).toBe('100');
  });

  it('writes per-day engagement history when enabled', async () => {
    const w = await world({ metricsHistory: true });
    const r = await w.pass();
    expect(r.written).toBe(6);
    const history = (await w.corpus()).filter((x) => x.path.includes('metrics-history/'));
    expect(history).toHaveLength(3);
    expect(history[0]!.frontmatter.platform).toBe('youtube');
    expect(history.map((h) => h.frontmatter.views).sort()).toEqual(['100', '200', '300']);
  });

  it('keeps hidden likes and disabled comments out of the record instead of writing zero', async () => {
    const w = await world();
    w.yt.updateVideo(video(3).id, { likes: undefined, comments: undefined });
    await w.pass();
    const rec = (await w.corpus()).find((x) => x.frontmatter.title === 'Video number 3')!;
    expect(rec.frontmatter.views).toBe('300');
    expect(rec.frontmatter.likes).toBeUndefined();
    expect(rec.frontmatter.comments).toBeUndefined();
  });
});

describe('youtube-videos errors and the API key', () => {
  it('maps quota and rate-limit refusals to rateLimited', async () => {
    for (const fault of [
      quotaExceeded(),
      json(
        {
          error: {
            code: 403,
            message: 'Rate limit',
            errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
          },
        },
        { status: 403 },
      ),
      status(429),
      status(503),
    ]) {
      const w = await world();
      w.http.failNext({ url: `${YOUTUBE_API_BASE}/channels` }, fault);
      const r = await w.pass();
      expect(r.rateLimited).toBe(true);
      expect(r.error).toBeUndefined();
      await env?.dispose();
      env = null;
    }
  });

  it('turns a refused key into an actionable error', async () => {
    const w = await world();
    w.yt.revokeKeys();
    expect((await w.pass()).error).toMatch(
      /refused this connector's API key \(API key not valid.*Check the API key credential/,
    );
  });

  it('says when the Data API is not enabled for the key', async () => {
    const w = await world();
    w.yt.disableApi();
    expect((await w.pass()).error).toMatch(/YouTube Data API v3 is not enabled/);
  });

  it('fails auth when no key is stored', async () => {
    env = await createConnectorTestEnv();
    const http = new FakeHttp();
    const adapter = new YouTubeVideosAdapter(binding(['@x']), env.deps({ fetch: http.fetch }));
    await expect(adapter.ensureAuth()).rejects.toThrow(/No YouTube API key is stored/);
  });

  it('accepts a JSON credential blob naming the key', async () => {
    const w = await world();
    await env!.storeCredential(binding(['@workshopbench']), { apiKey: FAKE_YOUTUBE_KEY });
    expect((await w.pass()).written).toBe(3);
  });

  it('never puts the key in a URL, an error or the corpus', async () => {
    const w = await world({ syncIntervalHours: 0 });
    await w.pass();
    for (const call of w.http.calls) {
      expect(call.url.href).not.toContain(FAKE_YOUTUBE_KEY);
      expect(call.url.searchParams.has('key')).toBe(false);
      expect(call.headers.get('x-goog-api-key')).toBe(FAKE_YOUTUBE_KEY);
    }
    // A server that echoes the key (or a key= URL) back in its error body.
    w.http.failNext(
      { url: `${YOUTUBE_API_BASE}/playlistItems` },
      json(
        {
          error: {
            code: 400,
            message: `Bad request for https://www.googleapis.com/youtube/v3/playlistItems?key=${FAKE_YOUTUBE_KEY}&part=x (${FAKE_YOUTUBE_KEY})`,
            errors: [{ reason: 'badRequest' }],
          },
        },
        { status: 400 },
      ),
    );
    const r = await w.pass();
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain(FAKE_YOUTUBE_KEY);
    expect(r.error).toContain('key=REDACTED');
    const corpus = JSON.stringify(await w.corpus());
    expect(corpus).not.toContain(FAKE_YOUTUBE_KEY);
    expect(JSON.stringify(r.cursor)).not.toContain(FAKE_YOUTUBE_KEY);
  });

  it('a refused-key fault on a valid key still reads as a credential problem', async () => {
    const w = await world();
    w.http.failNext({ url: `${YOUTUBE_API_BASE}/channels` }, apiKeyInvalid());
    expect((await w.pass()).error).toMatch(/credential/);
  });
});

describe('youtube-videos helpers', () => {
  it('reads ISO 8601 durations', () => {
    expect(isoDurationSeconds('PT4M13S')).toBe(253);
    expect(isoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(isoDurationSeconds('P1DT2H')).toBe(93_600);
    expect(isoDurationSeconds('P0D')).toBe(0);
    expect(isoDurationSeconds('PT')).toBeUndefined();
    expect(isoDurationSeconds('4:13')).toBeUndefined();
  });

  it('redacts keys from text', () => {
    expect(redactApiKey('x?key=abc123&y=1', 'zzzzzzzzzz')).toBe('x?key=REDACTED&y=1');
    expect(redactApiKey(`echo ${FAKE_YOUTUBE_KEY}`, FAKE_YOUTUBE_KEY)).toBe('echo REDACTED');
  });
});
