import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { status } from '../testing/fake-http.js';
import { FakeX, X_API } from '../testing/fake-x.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import { XPostsAdapter, createXRuntime, registerXAdapters } from './x-posts.js';

const MINUTE = 60_000;

/**
 * Conformance config: posts poll every 15 minutes (each hook advances the
 * fake clock 20), engagement refresh hourly (only the delete hook advances
 * past it), stats effectively never after the first pass, and no per-day
 * metrics-history rows — those are a deliberate second record per observed
 * post, so "a new post is the only thing the next pass writes" would count 2.
 * metrics-history behavior is covered in x-posts.test.ts.
 */
const CONFIG = {
  syncIntervalHours: 0.25,
  metricsRefreshHours: 1,
  statsIntervalHours: 720,
  metricsHistory: false,
};

function binding(config: Record<string, unknown> = CONFIG): ConnectorBindingRef {
  return { id: 'x-conf', type: 'x-posts', config };
}

/** Adapter over the fake's HTTP with the fake clock (the real runtime otherwise). */
function adapterFor(fake: FakeX, env: ConnectorTestEnv, config?: Record<string, unknown>) {
  const runtime = { ...createXRuntime(fake.http.fetch), now: () => fake.now };
  return new XPostsAdapter(binding(config), env.deps(), runtime);
}

describeConnectorConformance('x-posts', {
  async create() {
    const env = await createConnectorTestEnv();
    const fake = new FakeX();
    await env.storeCredential(binding(), fake.credential());
    fake.advance(-60 * MINUTE);
    for (const text of ['First post of the week', 'Shipping notes', 'Evening thoughts']) {
      fake.addPost(text, { likes: 2 });
      fake.advance(10 * MINUTE);
    }
    fake.advance(30 * MINUTE);
    let added = 0;
    return {
      env,
      // 3 posts + the day's account-stats record.
      seeded: 4,
      requiredKeys: ['title', 'date', 'platform', 'url'],
      adapter: async () => adapterFor(fake, env),
      unrouted: () => fake.http.unrouted,
      hooks: {
        add(n = 1) {
          fake.advance(20 * MINUTE);
          for (let i = 0; i < n; i++) fake.addPost(`New post ${++added}`);
        },
        update() {
          // An edit is a new post id upstream; the record keys on the original.
          fake.advance(20 * MINUTE);
          fake.editPost(fake.postIds()[1]!, 'Shipping notes (edited: now with links)');
        },
        remove() {
          // Deletions surface on the engagement re-walk, so step past it.
          fake.deletePost(fake.postIds()[0]!);
          fake.advance(61 * MINUTE);
        },
        move() {
          // Seeded on 31 August; an edit after midnight dates the post in
          // September, so its month bucket changes.
          fake.advance(3 * 60 * MINUTE);
          fake.editPost(fake.postIds()[0]!, 'Evening thoughts, revised after midnight');
        },
        throttleNextList() {
          fake.http.failNext(
            { method: 'GET', url: `${X_API}/users/${fake.userId}/tweets` },
            status(
              429,
              {
                title: 'Too Many Requests',
                detail: 'Too Many Requests',
                type: 'about:blank',
                status: 429,
              },
              { 'x-rate-limit-reset': String(Math.floor(fake.now.getTime() / 1000) + 900) },
            ),
          );
        },
        revokeAuth() {
          // Reads are interval-gated, so the next pass must be due to notice.
          fake.revoke();
          fake.advance(20 * MINUTE);
        },
        addHostile() {
          fake.advance(20 * MINUTE);
          fake.addPost(`${HOSTILE_NAME}\n${INJECTION_PAYLOAD}`);
        },
      },
    };
  },
});

describe('x-posts against the fake X API', () => {
  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  async function pass(
    adapter: XPostsAdapter,
    cursor: unknown,
    backfillLimit = 500,
  ): ReturnType<typeof syncWithAdapter> {
    return syncWithAdapter<unknown, NormalizedRecord>(adapter, {
      storageDir: env!.artifactsDir,
      quarantineDir: env!.quarantineDir,
      corpusDir: 'data/x',
      backfillLimit,
      cursor,
    });
  }

  it('the registered factory runs on the injected transport (deps.fetch)', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX({ now: new Date() });
    fake.addPost('Hello from the simulator');
    const b = binding({ metricsHistory: false });
    await env.storeCredential(b, fake.credential());
    registerXAdapters();
    const adapter = await NATIVE_ADAPTERS.get('x-posts')!(b, env.deps({ fetch: fake.http.fetch }));
    const r = await pass(adapter as XPostsAdapter, undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(2);
    expect(fake.http.unrouted).toEqual([]);
    expect(fake.http.calls.every((c) => c.url.origin === 'https://api.x.com')).toBe(true);
  });

  it('a backlog bigger than the per-round cap pages through until_id without losing posts', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    await env.storeCredential(binding(), fake.credential());
    fake.addPost('Before the backlog');
    let cursor = (await pass(adapterFor(fake, env), undefined)).cursor;

    fake.advance(20 * MINUTE);
    for (let i = 1; i <= 7; i++) {
      fake.addPost(`Backlog post ${i}`);
      fake.advance(MINUTE);
    }
    // A cap of 3 per round: the engine loops the scope on `partial`.
    const r = await pass(adapterFor(fake, env), cursor, 3);
    cursor = r.cursor;
    expect(r.error).toBeUndefined();
    const posts = (await readCorpus(env.artifactsDir, 'data/x/posts')).map(
      (x) => x.frontmatter.title,
    );
    expect(posts.sort()).toEqual(
      [
        'Before the backlog',
        ...Array.from({ length: 7 }, (_, i) => `Backlog post ${i + 1}`),
      ].sort(),
    );
    const timeline = fake.http.requests('GET', `${X_API}/users/${fake.userId}/tweets`);
    expect(timeline.some((c) => c.url.searchParams.has('until_id'))).toBe(true);
    // The walk finished, so the cursor carries no continuation.
    const scopes = (cursor as { scopes: Record<string, { walk?: unknown; sinceId?: string }> })
      .scopes;
    expect(scopes.posts?.walk).toBeUndefined();
    expect(scopes.posts?.sinceId).toBe(fake.postIds()[0]);
    await assertCorpusInvariants(env.artifactsDir, 'data/x');
  });

  it('a walk longer than one pass resumes on the next pass even inside the interval', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    await env.storeCredential(binding(), fake.credential());
    fake.addPost('Seed');
    const first = await pass(adapterFor(fake, env), undefined);
    fake.advance(20 * MINUTE);
    for (let i = 1; i <= 6; i++) fake.addPost(`Burst ${i}`);
    // One post per round, four rounds per pass: the first pass takes four.
    const second = await pass(adapterFor(fake, env), first.cursor, 1);
    expect(second.written).toBe(4);
    const pending = (second.cursor as { scopes: Record<string, { walk?: unknown }> }).scopes.posts;
    expect(pending?.walk).toBeDefined();
    // No clock movement: the interval gate must not strand the remainder.
    const third = await pass(adapterFor(fake, env), second.cursor, 1);
    expect(third.written).toBe(2);
    const posts = await readCorpus(env.artifactsDir, 'data/x/posts');
    expect(posts).toHaveLength(7);
    const quiet = await pass(adapterFor(fake, env), third.cursor, 1);
    expect(quiet.written).toBe(0);
  });

  it('an edited post refreshes its original record in place', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    await env.storeCredential(binding(), fake.credential());
    const original = fake.addPost('Typo in this postt');
    const first = await pass(adapterFor(fake, env), undefined);

    fake.advance(20 * MINUTE);
    const edited = fake.editPost(original, 'Typo fixed in this post');
    await pass(adapterFor(fake, env), first.cursor);
    const posts = await readCorpus(env.artifactsDir, 'data/x/posts');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.frontmatter).toMatchObject({
      title: 'Typo fixed in this post',
      tweet_id: edited,
      original_tweet_id: original,
    });
  });

  it('a deleted post leaves with its engagement readings', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    const config = { ...CONFIG, metricsHistory: true };
    await env.storeCredential(binding(config), fake.credential());
    const keep = fake.addPost('Keeper');
    const doomed = fake.addPost('Regrettable take');
    const first = await pass(adapterFor(fake, env, config), undefined);
    const before = await readCorpus(env.artifactsDir, 'data/x/posts');
    expect(before.filter((x) => x.frontmatter.post_id === doomed)).toHaveLength(1);

    fake.deletePost(doomed);
    fake.advance(61 * MINUTE);
    const r = await pass(adapterFor(fake, env, config), first.cursor);
    expect(r.pruned).toBe(2);
    const after = await readCorpus(env.artifactsDir, 'data/x/posts');
    expect(after.some((x) => `${x.frontmatter.title}${x.body}`.includes('Regrettable'))).toBe(
      false,
    );
    expect(after.some((x) => x.frontmatter.tweet_id === keep)).toBe(true);
  });

  it('an exhausted credit balance fails the pass with the fix named, keeping the cursor', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    await env.storeCredential(binding(), fake.credential());
    fake.addPost('One');
    const first = await pass(adapterFor(fake, env), undefined);
    fake.advance(20 * MINUTE);
    fake.http.failNext(
      { url: `${X_API}/users/${fake.userId}/tweets` },
      status(402, {
        title: 'CreditsDepleted',
        detail: 'Your account has no credits.',
        status: 402,
      }),
    );
    const r = await pass(adapterFor(fake, env), first.cursor);
    expect(r.rateLimited).toBeUndefined();
    expect(r.error).toMatch(/credits or spending limit.*console\.x\.com/);
    expect(JSON.stringify(r.cursor)).toBe(JSON.stringify(first.cursor));
  });

  it('a token refused early is refreshed once, rotating the stored refresh token', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    const b = binding();
    const seeded = fake.credential();
    await env.storeCredential(b, seeded);
    fake.addPost('One');
    fake.http.failNext(
      { url: `${X_API}/users/me` },
      status(401, {
        title: 'Unauthorized',
        type: 'about:blank',
        status: 401,
        detail: 'Unauthorized',
      }),
    );
    const r = await pass(adapterFor(fake, env), undefined);
    expect(r.error).toBeUndefined();
    const stored = await env.readCredential<{ refreshToken: string; accessToken: string }>(b);
    expect(stored?.refreshToken).not.toBe(seeded.refreshToken);
    expect(stored?.accessToken).not.toBe('access-seed');
    expect(fake.tokens.grants.map((g) => g.get('grant_type'))).toEqual(['refresh_token']);
  });

  it('publishes through POST /2/tweets on the injected transport', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeX();
    const config = { allowPublish: true };
    await env.storeCredential(binding(config), fake.credential());
    const adapter = adapterFor(fake, env, config);
    await adapter.ensureAuth();
    const receipt = (await adapter.runAction('publish', { text: 'Hello (world)' })) as {
      id: string;
      permalink: string;
    };
    expect(fake.postIds()[0]).toBe(receipt.id);
    expect(receipt.permalink).toBe(`https://x.com/i/status/${receipt.id}`);
  });
});
