/**
 * LinkedIn's connector contract, checked against the fake LinkedIn API.
 *
 * `describeConnectorConformance` cannot run here: its required `add` hook
 * means "a new upstream record appears", and LinkedIn restricts member-post
 * reads to its partner program, so this adapter never lists a record (the
 * corpus holds only publish receipts, which the outbox writes). The checks
 * that do apply — quiet passes cost nothing, throttling keeps the cursor, a
 * dead grant fails actionably, every request is one the fake models — run
 * here through the real runtime and `syncWithAdapter`, plus the publish path
 * the connector exists for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import { status } from '../testing/fake-http.js';
import { FakeLinkedIn, LINKEDIN_API } from '../testing/fake-linkedin.js';
import { type ConnectorTestEnv, createConnectorTestEnv, listFiles } from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import {
  LinkedInPostsAdapter,
  createLinkedInRuntime,
  registerLinkedInAdapters,
} from './linkedin-posts.js';

function binding(
  config: Record<string, unknown> = { allowPublish: true },
  cursor?: unknown,
): ConnectorBindingRef {
  return { id: 'li-conf', type: 'linkedin-posts', config, ...(cursor ? { cursor } : {}) };
}

describe('linkedin-posts — connector contract against the fake LinkedIn API', () => {
  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  async function setup(credential?: Record<string, string>) {
    env = await createConnectorTestEnv();
    const fake = new FakeLinkedIn();
    await env.storeCredential(binding(), credential ?? fake.credential());
    const adapter = (cursor?: unknown) =>
      new LinkedInPostsAdapter(
        binding({ allowPublish: true }, cursor),
        env!.deps(),
        createLinkedInRuntime(fake.http.fetch),
      );
    const pass = (cursor: unknown) =>
      syncWithAdapter<unknown, NormalizedRecord>(adapter(cursor), {
        storageDir: env!.artifactsDir,
        quarantineDir: env!.quarantineDir,
        corpusDir: 'data/linkedin',
        backfillLimit: 500,
        cursor,
      });
    return { fake, adapter, pass };
  }

  it('a first pass writes nothing and pins the member id; later passes make no requests', async () => {
    const { fake, pass } = await setup();
    const first = await pass(undefined);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(0);
    expect(fake.http.calls.map((c) => c.url.pathname)).toEqual(['/v2/userinfo']);
    const quiet = await pass(first.cursor);
    expect(quiet.error).toBeUndefined();
    expect(fake.http.calls).toHaveLength(1);
    expect(await listFiles(env!.artifactsDir)).toEqual([]);
    expect(fake.http.unrouted).toEqual([]);
  });

  it('a throttled userinfo read reports rateLimited and keeps the cursor', async () => {
    const { fake, pass } = await setup();
    fake.http.failNext(
      { url: `${LINKEDIN_API}/v2/userinfo` },
      status(429, {
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        message: 'Resource level throttle limit',
      }),
    );
    const r = await pass(undefined);
    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.cursor).toEqual({ v: 2, scopes: {} });
  });

  it('a revoked grant fails the pass with an actionable message', async () => {
    const { fake, pass } = await setup();
    fake.revoke();
    const r = await pass(undefined);
    expect(r.error).toMatch(/reconnect this LinkedIn account/);
  });

  it('an expired token asks for a reconnect without spending a request', async () => {
    const { fake, pass } = await setup({
      accessToken: 'li-seed',
      expiresAt: '2000-01-01T00:00:00.000Z',
      refreshMode: 'none',
    });
    const r = await pass(undefined);
    expect(r.error).toMatch(/reconnect this LinkedIn account.*60 days/);
    expect(fake.http.calls).toHaveLength(0);
  });

  it('publishes on an active API version with little-escaped commentary', async () => {
    const { fake, pass, adapter } = await setup();
    const { cursor } = await pass(undefined);
    const live = adapter(cursor);
    await live.ensureAuth();
    const text = 'Big news (finally!) — v2 ships [today] #launch, thanks to @team & C# folks';
    const receipt = (await live.runAction('publish', { text })) as {
      id: string;
      permalink: string;
    };

    expect(fake.posts).toHaveLength(1);
    const post = fake.posts[0]!;
    expect(post.urn).toBe(receipt.id);
    expect(receipt.permalink).toBe(`https://www.linkedin.com/feed/update/${receipt.id}/`);
    expect(post.commentary).toBe(
      'Big news \\(finally!\\) — v2 ships \\[today\\] #launch, thanks to \\@team & C\\# folks',
    );
    // The member id came from the pinned cursor, not a second userinfo read.
    expect(fake.http.requests('GET', `${LINKEDIN_API}/v2/userinfo`)).toHaveLength(1);
  });

  it('the registered factory runs on the injected transport (deps.fetch)', async () => {
    env = await createConnectorTestEnv();
    const fake = new FakeLinkedIn();
    const b = binding();
    await env.storeCredential(b, fake.credential());
    registerLinkedInAdapters();
    const live = (await NATIVE_ADAPTERS.get('linkedin-posts')!(
      b,
      env.deps({ fetch: fake.http.fetch }),
    )) as LinkedInPostsAdapter;
    await live.ensureAuth();
    await live.runAction('publish', { text: 'Hello from the simulator' });
    expect(fake.posts.map((p) => p.commentary)).toEqual(['Hello from the simulator']);
    expect(fake.http.unrouted).toEqual([]);
  });
});
