import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { XPostsAdapter, createXRuntime } from '../natives/x-posts.js';
import { FakeX } from '../testing/fake-x.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import { replayExchanges } from '../testing/replay-exchanges.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import { captureFetch } from './capture-fetch.js';
import { CassetteLeakError, assertNoLeak, scrubExchanges } from './scrub.js';

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('scrubExchanges', () => {
  it('keeps what logic branches on and replaces what a person wrote, consistently', async () => {
    const server: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/events') {
        return json(
          {
            items: [
              {
                id: 'evt-Q7xk2',
                status: 'confirmed',
                summary: 'Dinner with Ada',
                start: '2026-11-16T19:00:00Z',
                organizer: 'ada@lovelace.example',
              },
            ],
            nextPageToken: 'CgwIgICAgICAgICAgP8BEAE',
          },
          { 'set-cookie': 'session=abc', 'x-ratelimit-remaining': '42' },
        );
      }
      return json({ items: [] });
    };
    const { fetch, exchanges } = captureFetch(server);
    await fetch('https://api.example/events?maxResults=50&access_token=sk-live-abcdef', {
      headers: { authorization: 'Bearer sk-live-abcdef' },
    });
    await fetch('https://api.example/events?pageToken=CgwIgICAgICAgICAgP8BEAE');
    const cassette = scrubExchanges(exchanges, { secrets: ['sk-live-abcdef'] });
    const text = JSON.stringify(cassette);

    expect(text).not.toContain('Dinner with Ada');
    expect(text).not.toContain('ada@lovelace.example');
    expect(text).not.toContain('session=abc');
    expect(text).toContain('confirmed');
    expect(text).toContain('2026-11-16T19:00:00Z');
    expect(text).toContain('x-ratelimit-remaining');
    const first = cassette[0]!;
    if (first.kind !== 'http') throw new Error('unreachable');
    expect(first.request.url).toContain('access_token=REDACTED');
    expect(first.request.url).toContain('maxResults=50');
    // The page token handed out is replaced the same way in the next request.
    const token = (first.response.body as { nextPageToken: string }).nextPageToken;
    expect(token).toMatch(/^p-[0-9a-f]{10}$/);
    const second = cassette[1]!;
    if (second.kind !== 'http') throw new Error('unreachable');
    expect(new URL(second.request.url).searchParams.get('pageToken')).toBe(token);
  });

  it('fails closed when a credential or bearer token would survive', () => {
    expect(() =>
      assertNoLeak('{"note":"sk-live-abcdef"}', { secrets: ['sk-live-abcdef'] }),
    ).toThrow(CassetteLeakError);
    expect(() => assertNoLeak('Authorization: Bearer abcdefghijkl', {})).toThrow(CassetteLeakError);
    expect(() =>
      assertNoLeak('{"x":"Dinner with Ada"}', { originals: ['Dinner with Ada'] }),
    ).toThrow(CassetteLeakError);
    expect(() =>
      assertNoLeak('{"x":"p-0123456789"}', { secrets: ['sk-live-abcdef'] }),
    ).not.toThrow();
  });
});

describe('a recorded pass replays', () => {
  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  it('a scrubbed X pass, replayed, writes the same records with nothing a person wrote', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    const b: ConnectorBindingRef = {
      id: 'x-cap',
      type: 'x-posts',
      config: { metricsHistory: false },
    };
    await env.storeCredential(b, fake.credential());
    fake.addPost('Shipping notes for the week');
    fake.addPost('A private thought, recorded');
    const capture = captureFetch(fake.http.fetch);
    const opts = {
      quarantineDir: env.quarantineDir,
      backfillLimit: 500,
      cursor: undefined,
    };
    const live = await syncWithAdapter<unknown, NormalizedRecord>(
      new XPostsAdapter(b, env.deps(), { ...createXRuntime(capture.fetch), now: () => fake.now }),
      { ...opts, storageDir: env.artifactsDir, corpusDir: 'data/live' },
    );
    expect(live.written).toBeGreaterThan(0);
    const cassette = scrubExchanges(capture.exchanges, { secrets: ['access-seed'] });
    expect(JSON.stringify(cassette)).not.toContain('Shipping notes');

    const replay = replayExchanges(cassette);
    const replayed = await syncWithAdapter<unknown, NormalizedRecord>(
      new XPostsAdapter(b, env.deps(), { ...createXRuntime(replay.fetch), now: () => fake.now }),
      { ...opts, storageDir: env.artifactsDir, corpusDir: 'data/replayed' },
    );
    expect(replayed.error).toBeUndefined();
    expect(replay.unmatched).toEqual([]);
    expect(replayed.written).toBe(live.written);
    const titles = (await readCorpus(env.artifactsDir, 'data/replayed')).map(
      (r) => r.frontmatter.title ?? '',
    );
    expect(titles.some((t) => t.includes('Shipping'))).toBe(false);
  });
});
