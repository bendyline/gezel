import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { FakeBluesky } from '../testing/fake-bluesky.js';
import { status } from '../testing/fake-http.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import {
  BlueskyPostsAdapter,
  createBlueskyRuntime,
  registerBlueskyAdapters,
} from './bluesky-posts.js';

const MINUTE = 60_000;

/**
 * Conformance config: engagement refresh hourly (only the update and delete
 * hooks step past it), stats effectively never after the first pass, and no
 * per-day metrics-history rows — those are a deliberate second record per
 * observed post, so "a new post is the only thing the next pass writes" would
 * count 2. metrics-history behavior is covered in bluesky-posts.test.ts.
 */
function config(fake: FakeBluesky, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: fake.handle,
    service: fake.service,
    syncMentions: true,
    metricsRefreshHours: 1,
    statsIntervalHours: 720,
    metricsHistory: false,
    ...extra,
  };
}

function binding(cfg: Record<string, unknown>): ConnectorBindingRef {
  return { id: 'bsky-conf', type: 'bluesky-posts', config: cfg };
}

/** The real runtime (AtpAgent over the fake's HTTP), on the fake clock. */
function adapterFor(fake: FakeBluesky, env: ConnectorTestEnv, cfg = config(fake)) {
  const runtime = { ...createBlueskyRuntime(fake.http.fetch), now: () => fake.now };
  return new BlueskyPostsAdapter(binding(cfg), env.deps(), runtime);
}

describeConnectorConformance('bluesky-posts', {
  async create() {
    const env = await createConnectorTestEnv();
    const fake = new FakeBluesky();
    await env.storeCredential(binding(config(fake)), { appPassword: fake.appPassword });
    fake.advance(-60 * MINUTE);
    for (const text of ['Morning coffee thoughts', 'Shipping notes', 'Evening walk']) {
      fake.addPost(text, { likes: 1 });
      fake.advance(10 * MINUTE);
    }
    fake.addRepost('Someone else said something worth sharing');
    fake.addMention('@gezelfake.bsky.social have you seen this?');
    fake.advance(20 * MINUTE);
    let added = 0;
    return {
      env,
      // 3 posts + 1 mention + the day's account-stats record (the repost is skipped).
      seeded: 5,
      requiredKeys: ['title', 'date', 'platform', 'url'],
      adapter: async () => adapterFor(fake, env),
      unrouted: () => fake.http.unrouted,
      hooks: {
        add(n = 1) {
          fake.advance(20 * MINUTE);
          for (let i = 0; i < n; i++) fake.addPost(`New post ${++added}`);
        },
        update() {
          // Posts cannot be edited on Bluesky; engagement moving is the update,
          // seen by the next engagement re-walk.
          fake.setLikes(fake.postRkeys()[1]!, 99);
          fake.advance(61 * MINUTE);
        },
        remove() {
          // Deletions surface on the engagement re-walk, so step past it.
          fake.deletePost(fake.postRkeys()[0]!);
          fake.advance(61 * MINUTE);
        },
        throttleNextList() {
          fake.http.failNext(
            { method: 'GET', url: `${fake.service}/xrpc/app.bsky.feed.getAuthorFeed` },
            status(
              429,
              { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
              { 'ratelimit-remaining': '0', 'ratelimit-reset': '1788220800' },
            ),
          );
        },
        revokeAuth() {
          fake.revoke();
        },
        addHostile() {
          fake.advance(20 * MINUTE);
          fake.addPost(`${HOSTILE_NAME}\n${INJECTION_PAYLOAD}`);
        },
      },
    };
  },
});

describe('bluesky-posts against the fake PDS', () => {
  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  async function pass(adapter: BlueskyPostsAdapter, cursor: unknown, backfillLimit = 500) {
    return syncWithAdapter<unknown, NormalizedRecord>(adapter, {
      storageDir: env!.artifactsDir,
      quarantineDir: env!.quarantineDir,
      corpusDir: 'data/bsky',
      backfillLimit,
      cursor,
    });
  }

  it('the registered factory runs on the injected transport (deps.fetch)', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky({ now: new Date() });
    fake.addPost('Hello from the simulator');
    const b = binding(config(fake));
    await env.storeCredential(b, { appPassword: fake.appPassword });
    registerBlueskyAdapters();
    const adapter = await NATIVE_ADAPTERS.get('bluesky-posts')!(
      b,
      env.deps({ fetch: fake.http.fetch }),
    );
    const r = await pass(adapter as BlueskyPostsAdapter, undefined);
    expect(r.error).toBeUndefined();
    // The post + the stats record (mentions: none yet).
    expect(r.written).toBe(2);
    expect(fake.http.unrouted).toEqual([]);
  });

  it('signs in once and resumes the session on later passes (sign-ins are rationed)', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky({ loginLimit: 1 });
    await env.storeCredential(binding(config(fake)), { appPassword: fake.appPassword });
    fake.addPost('One');
    let cursor: unknown;
    for (let i = 0; i < 5; i++) {
      const r = await pass(adapterFor(fake, env), cursor);
      expect(r.error).toBeUndefined();
      cursor = r.cursor;
      fake.advance(5 * MINUTE);
    }
    expect(fake.logins).toBe(1);
    expect(fake.refreshes).toBe(4);
  });

  it('a rationed sign-in is reported as a limit, not as a wrong password', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky({ loginLimit: 0 });
    await env.storeCredential(binding(config(fake)), { appPassword: fake.appPassword });
    const r = await pass(adapterFor(fake, env), undefined);
    expect(r.error).toMatch(/limiting sign-ins/);
    expect(r.error).not.toMatch(/Check the handle and app password/);
  });

  it('a backlog bigger than the per-round cap continues from the feed cursor without gaps', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky();
    await env.storeCredential(binding(config(fake)), { appPassword: fake.appPassword });
    fake.addPost('Before the backlog');
    let cursor = (await pass(adapterFor(fake, env), undefined)).cursor;

    fake.advance(20 * MINUTE);
    for (let i = 1; i <= 9; i++) {
      fake.addPost(`Backlog post ${i}`);
      fake.advance(MINUTE);
    }
    // Two per round, four rounds per pass: the remainder resumes next pass.
    const r1 = await pass(adapterFor(fake, env), cursor, 2);
    expect(r1.written).toBe(8);
    const r2 = await pass(adapterFor(fake, env), r1.cursor, 2);
    expect(r2.written).toBe(1);
    cursor = r2.cursor;
    const titles = (await readCorpus(env.artifactsDir, 'data/bsky/posts')).map(
      (x) => x.frontmatter.title,
    );
    expect(titles.sort()).toEqual(
      [
        'Before the backlog',
        ...Array.from({ length: 9 }, (_, i) => `Backlog post ${i + 1}`),
      ].sort(),
    );
    const posts = (cursor as { scopes: Record<string, { walk?: unknown }> }).scopes.posts;
    expect(posts?.walk).toBeUndefined();
    await assertCorpusInvariants(env.artifactsDir, 'data/bsky');
  });

  it('engagement-history rows never push posts past the engine cap', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky();
    const cfg = config(fake, { metricsHistory: true, syncMentions: false });
    await env.storeCredential(binding(cfg), { appPassword: fake.appPassword });
    for (let i = 1; i <= 4; i++) {
      fake.addPost(`Post ${i}`);
      fake.advance(MINUTE);
    }
    const r = await pass(adapterFor(fake, env, cfg), undefined, 6);
    expect(r.skipped).toBe(0);
    const posts = await readCorpus(env.artifactsDir, 'data/bsky/posts');
    expect(posts.filter((x) => !x.path.startsWith('metrics-history/'))).toHaveLength(4);
    expect(posts.filter((x) => x.path.startsWith('metrics-history/'))).toHaveLength(2);
  });

  it('a deleted post leaves with its engagement readings', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky();
    const cfg = config(fake, { metricsHistory: true, syncMentions: false });
    await env.storeCredential(binding(cfg), { appPassword: fake.appPassword });
    fake.addPost('Keeper');
    fake.advance(MINUTE);
    const doomed = fake.addPost('Regrettable take');
    const first = await pass(adapterFor(fake, env, cfg), undefined);

    fake.deletePost(doomed);
    fake.advance(61 * MINUTE);
    const r = await pass(adapterFor(fake, env, cfg), first.cursor);
    expect(r.pruned).toBe(2);
    const after = await readCorpus(env.artifactsDir, 'data/bsky/posts');
    expect(after.some((x) => `${x.frontmatter.title}${x.body}`.includes('Regrettable'))).toBe(
      false,
    );
    expect(after.some((x) => x.frontmatter.title === 'Keeper')).toBe(true);
  });

  it('publishes through createRecord on the injected transport', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeBluesky();
    const cfg = config(fake, { allowPublish: true });
    await env.storeCredential(binding(cfg), { appPassword: fake.appPassword });
    const adapter = adapterFor(fake, env, cfg);
    await adapter.ensureAuth();
    const receipt = (await adapter.runAction('publish', { text: 'Hello from the fake PDS' })) as {
      uri: string;
      permalink: string;
    };
    const rkey = fake.postRkeys()[0]!;
    expect(receipt.uri).toBe(`at://${fake.did}/app.bsky.feed.post/${rkey}`);
    expect(receipt.permalink).toBe(`https://bsky.app/profile/${fake.handle}/post/${rkey}`);
  });
});
