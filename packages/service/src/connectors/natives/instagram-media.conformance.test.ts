import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { status } from '../testing/fake-http.js';
import { FakeInstagram, IG_GRAPH } from '../testing/fake-instagram.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import {
  InstagramMediaAdapter,
  createInstagramRuntime,
  registerInstagramAdapters,
} from './instagram-media.js';

const MINUTE = 60_000;

/**
 * Conformance config: engagement refresh hourly (only the update and delete
 * hooks step past it), stats effectively never after the first pass, and no
 * per-day metrics-history rows — those are a deliberate second record per
 * observed item, so "a new post is the only thing the next pass writes" would
 * count 2. metrics-history behavior is covered in instagram-media.test.ts.
 */
const CONFIG = { metricsRefreshHours: 1, statsIntervalHours: 720, metricsHistory: false };

function binding(config: Record<string, unknown> = CONFIG): ConnectorBindingRef {
  return { id: 'ig-conf', type: 'instagram-media', config };
}

/** The real runtime over the fake's HTTP, on the fake clock. */
function adapterFor(
  fake: FakeInstagram,
  env: ConnectorTestEnv,
  config: Record<string, unknown> = CONFIG,
) {
  const runtime = { ...createInstagramRuntime(fake.http.fetch), now: () => fake.now };
  return new InstagramMediaAdapter(binding(config), env.deps(), runtime);
}

describeConnectorConformance('instagram-media', {
  async create() {
    const env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    await env.storeCredential(binding(), fake.credential());
    fake.advance(-60 * MINUTE);
    for (const caption of ['Workshop bench at dawn', 'New chisels arrived', 'Finished stool']) {
      fake.addMedia(caption, { likes: 4 });
      fake.advance(10 * MINUTE);
    }
    fake.advance(30 * MINUTE);
    let added = 0;
    return {
      env,
      // 3 media + the day's account-stats record.
      seeded: 4,
      requiredKeys: ['title', 'date', 'platform', 'url'],
      adapter: async () => adapterFor(fake, env),
      unrouted: () => fake.http.unrouted,
      hooks: {
        add(n = 1) {
          fake.advance(20 * MINUTE);
          for (let i = 0; i < n; i++) fake.addMedia(`New photo ${++added}`);
        },
        update() {
          // Captions are editable; the engagement re-walk is what sees them.
          fake.editCaption(fake.mediaIds()[1]!, 'New chisels arrived (Sheffield steel)');
          fake.advance(61 * MINUTE);
        },
        remove() {
          fake.deleteMedia(fake.mediaIds()[0]!);
          fake.advance(61 * MINUTE);
        },
        throttleNextList() {
          fake.http.failNext(
            { method: 'GET', url: /graph\.instagram\.com\/v\d+\.0\/me\/media\?/ },
            status(400, {
              error: {
                message:
                  'There have been too many calls to this Instagram account. Wait a bit and try again.',
                type: 'OAuthException',
                code: 80002,
                fbtrace_id: 'AfakeTrace02',
              },
            }),
          );
        },
        revokeAuth() {
          fake.revoke();
        },
        addHostile() {
          fake.advance(20 * MINUTE);
          fake.addMedia(`${HOSTILE_NAME}\n${INJECTION_PAYLOAD}`);
        },
      },
    };
  },
});

describe('instagram-media against the fake Graph API', () => {
  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  async function pass(adapter: InstagramMediaAdapter, cursor: unknown, backfillLimit = 500) {
    return syncWithAdapter<unknown, NormalizedRecord>(adapter, {
      storageDir: env!.artifactsDir,
      quarantineDir: env!.quarantineDir,
      corpusDir: 'data/ig',
      backfillLimit,
      cursor,
    });
  }

  it('the registered factory runs on the injected transport (deps.fetch)', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram({ now: new Date() });
    fake.addMedia('Hello from the simulator');
    const b = binding({ metricsHistory: false });
    await env.storeCredential(b, fake.credential());
    registerInstagramAdapters();
    const adapter = await NATIVE_ADAPTERS.get('instagram-media')!(
      b,
      env.deps({ fetch: fake.http.fetch }),
    );
    const r = await pass(adapter as InstagramMediaAdapter, undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(2);
    expect(fake.http.unrouted).toEqual([]);
    expect([...fake.versions]).toEqual(['v25.0']);
  });

  it('a backlog spanning pages continues across rounds, and no cursor holds the token', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    // Keep the engagement re-walk out of it: only the backlog should be written.
    const config = { ...CONFIG, metricsRefreshHours: 24 };
    await env.storeCredential(binding(config), fake.credential());
    fake.addMedia('Before the backlog');
    let cursor = (await pass(adapterFor(fake, env, config), undefined)).cursor;

    fake.advance(20 * MINUTE);
    for (let i = 1; i <= 70; i++) {
      fake.addMedia(`Backlog ${i}`);
      fake.advance(MINUTE);
    }
    const seenCursors: string[] = [];
    const adapter = adapterFor(fake, env, config);
    const listChangesSince = adapter.listChangesSince.bind(adapter);
    adapter.listChangesSince = async (...args) => {
      const batch = await listChangesSince(...args);
      seenCursors.push(JSON.stringify(batch.cursor));
      return batch;
    };
    const r = await pass(adapter, cursor, 20);
    cursor = r.cursor;
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(70);
    // Mid-walk cursors pointed at a second page — without the access token.
    expect(seenCursors.some((c) => c.includes('"page"'))).toBe(true);
    expect(seenCursors.every((c) => !c.includes('ig-seed'))).toBe(true);
    const media = await readCorpus(env.artifactsDir, 'data/ig/media');
    expect(media).toHaveLength(71);
    await assertCorpusInvariants(env.artifactsDir, 'data/ig');
  });

  it('renews a near-expiry token through ig_refresh_token and re-persists it', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    const b = binding();
    await env.storeCredential(b, fake.credential(3));
    fake.addMedia('One');
    const r = await pass(adapterFor(fake, env), undefined);
    expect(r.error).toBeUndefined();
    const stored = await env.readCredential<{ accessToken: string }>(b);
    expect(stored?.accessToken).toMatch(/^ig-refreshed-/);
  });

  it('a lapsed token asks for a re-link without a request', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    await env.storeCredential(binding(), fake.credential(-1));
    const r = await pass(adapterFor(fake, env), undefined);
    expect(r.error).toMatch(/Re-link the account/);
    expect(fake.http.calls).toHaveLength(0);
  });

  it('a deleted post leaves with its engagement readings; an edited caption refreshes', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    const config = { ...CONFIG, metricsHistory: true };
    await env.storeCredential(binding(config), fake.credential());
    const keep = fake.addMedia('Keeper');
    fake.advance(MINUTE);
    const doomed = fake.addMedia('Regrettable photo');
    const first = await pass(adapterFor(fake, env, config), undefined);

    fake.deleteMedia(doomed);
    fake.editCaption(keep, 'Keeper, captioned properly');
    fake.advance(61 * MINUTE);
    const r = await pass(adapterFor(fake, env, config), first.cursor);
    expect(r.pruned).toBe(2);
    const media = await readCorpus(env.artifactsDir, 'data/ig/media');
    expect(media.some((x) => `${x.frontmatter.title}${x.body}`.includes('Regrettable'))).toBe(
      false,
    );
    expect(media.find((x) => x.frontmatter.media_id === keep)?.frontmatter.title).toBe(
      'Keeper, captioned properly',
    );
  });

  it('publishes through the container flow on the injected transport', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeInstagram();
    const config = { allowPublish: true };
    await env.storeCredential(binding(config), fake.credential());
    const adapter = adapterFor(fake, env, config);
    await adapter.ensureAuth();
    const receipt = (await adapter.runAction('publish', {
      caption: 'Fresh from the bench',
      imageUrl: 'https://cdn.example.com/bench.jpg',
    })) as { id: string; permalink?: string };
    expect(fake.mediaIds()[0]).toBe(receipt.id);
    expect(receipt.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    expect(fake.http.requests('POST', `${IG_GRAPH}/v25.0/me/media_publish`)).toHaveLength(1);
  });
});
