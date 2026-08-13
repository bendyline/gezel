import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { OAuthTokens, RefreshTokenParams } from '../oauth.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import {
  LinkedInApiError,
  LinkedInPostsAdapter,
  type LinkedInRuntime,
  linkedInPermalink,
} from './linkedin-posts.js';

const SUB = 'AbC123xYz';
const POST_URN = 'urn:li:share:7100000000000000001';

function binding(config: Record<string, unknown> = {}, cursor?: unknown): ConnectorBindingRef {
  return {
    id: 'li-1',
    type: 'linkedin-posts',
    config,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** The ordinary blob completeOAuth persists for a longLived provider. */
function cred(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: 'tok-1',
    expiresAt: '2999-01-01T00:00:00.000Z',
    refreshMode: 'none',
    ...overrides,
  });
}

function makeDeps(initialBlob: string | null): { deps: AdapterDeps; secrets: Map<string, string> } {
  const map = new Map<string, string>();
  if (initialBlob !== null) map.set('connector-linkedin-posts:li-1', initialBlob);
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

interface PostCall {
  url: string;
  accessToken: string;
  headers: Record<string, string>;
  body: unknown;
}

interface HarnessState {
  userinfo: Record<string, unknown>;
  userinfoError: unknown;
  postError: unknown;
  postUrn: string;
  requests: string[];
  postCalls: PostCall[];
  refreshCalls: RefreshTokenParams[];
  refreshResult: OAuthTokens;
  now: Date;
}

function harness(): { runtime: LinkedInRuntime; state: HarnessState } {
  const state: HarnessState = {
    userinfo: { sub: SUB, name: 'Tester' },
    userinfoError: undefined,
    postError: undefined,
    postUrn: POST_URN,
    requests: [],
    postCalls: [],
    refreshCalls: [],
    refreshResult: {
      accessToken: 'tok-2',
      refreshToken: 'refresh-2',
      expiresAt: '2999-01-02T00:00:00.000Z',
    },
    now: new Date('2026-08-12T12:00:00.000Z'),
  };
  const runtime: LinkedInRuntime = {
    getJson: async (url) => {
      state.requests.push(url);
      if (state.userinfoError) throw state.userinfoError;
      return { ...state.userinfo };
    },
    postJson: async (url, accessToken, headers, body) => {
      state.postCalls.push({ url, accessToken, headers, body });
      if (state.postError) throw state.postError;
      return { urn: state.postUrn };
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
  cursor?: unknown,
): Promise<{
  adapter: LinkedInPostsAdapter;
  state: HarnessState;
  secrets: Map<string, string>;
}> {
  const { runtime, state } = harness();
  const { deps, secrets } = makeDeps(blob);
  const adapter = new LinkedInPostsAdapter(binding(config, cursor), deps, runtime);
  await adapter.ensureAuth();
  return { adapter, state, secrets };
}

describe('LinkedInPostsAdapter auth + scopes', () => {
  it('fails ensureAuth with an actionable message when no credential is stored', async () => {
    const { runtime } = harness();
    const { deps } = makeDeps(null);
    const adapter = new LinkedInPostsAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/No stored credential/);
  });

  it('expired refreshMode-none token → actionable reconnect error, no refresh attempt', async () => {
    const { runtime, state } = harness();
    const { deps } = makeDeps(cred({ expiresAt: '2000-01-01T00:00:00.000Z' }));
    const adapter = new LinkedInPostsAdapter(binding(), deps, runtime);
    await expect(adapter.ensureAuth()).rejects.toThrow(/reconnect this LinkedIn account.*60 days/i);
    expect(state.refreshCalls).toEqual([]);
  });

  it('a live refreshMode-none token authenticates without any network call', async () => {
    const { state } = await readyAdapter();
    expect(state.requests).toEqual([]);
    expect(state.refreshCalls).toEqual([]);
  });

  it('an expired PARTNER-shaped blob (refresh token present) refreshes and re-persists', async () => {
    const { state, secrets } = await readyAdapter(
      {},
      JSON.stringify({
        accessToken: 'tok-1',
        refreshToken: 'refresh-1',
        expiresAt: '2000-01-01T00:00:00.000Z',
        clientId: 'client-1',
        clientSecret: 'secret-1',
      }),
    );
    expect(state.refreshCalls).toHaveLength(1);
    expect(state.refreshCalls[0]).toMatchObject({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
    });
    expect(state.refreshCalls[0]!.endpoints.tokenEndpoint).toBe(
      'https://www.linkedin.com/oauth/v2/accessToken',
    );
    const persisted = JSON.parse(secrets.get('connector-linkedin-posts:li-1')!) as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({ accessToken: 'tok-2', refreshToken: 'refresh-2' });
  });

  it('lists exactly one scope: posts (no timeline, no mentions, no stats)', async () => {
    const { adapter } = await readyAdapter();
    expect(await adapter.listScopes()).toEqual(['posts']);
  });
});

describe('LinkedInPostsAdapter posts scope (empty by design)', () => {
  it('first pass returns an EMPTY batch and pins the member sub into the cursor', async () => {
    const { adapter, state } = await readyAdapter();
    const first = await adapter.listChangesSince('posts', undefined);
    expect(first.records).toEqual([]);
    expect(first.cursor).toEqual({ sub: SUB });
    expect(state.requests).toEqual(['https://api.linkedin.com/v2/userinfo']);
  });

  it('later passes with a pinned cursor return empty batches with ZERO requests', async () => {
    const { runtime, state } = harness();
    const { deps } = makeDeps(cred());
    const adapter = new LinkedInPostsAdapter(binding(), deps, runtime);
    await adapter.ensureAuth();
    const first = await adapter.listChangesSince('posts', undefined);
    state.requests.length = 0;

    // A FRESH adapter (construct-per-pass) — only the cursor carries the pin.
    const next = new LinkedInPostsAdapter(binding(), deps, runtime);
    await next.ensureAuth();
    const second = await next.listChangesSince('posts', first.cursor);
    expect(second.records).toEqual([]);
    expect(second.cursor).toEqual({ sub: SUB });
    expect(state.requests).toEqual([]);
  });

  it('maps a rate-limited userinfo to rateLimited (cursor kept) and 401 to the reconnect error', async () => {
    const { adapter, state } = await readyAdapter();
    state.userinfoError = new LinkedInApiError(429, 'throttled');
    const limited = await adapter.listChangesSince('posts', undefined);
    expect(limited).toEqual({ records: [], cursor: {}, rateLimited: true });

    state.userinfoError = new LinkedInApiError(401, 'revoked');
    await expect(adapter.listChangesSince('posts', undefined)).rejects.toThrow(
      /reconnect this LinkedIn account/,
    );
  });

  it('unknown scopes return empty batches and fetchRecord always refuses', async () => {
    const { adapter } = await readyAdapter();
    expect(await adapter.listChangesSince('mentions', { keep: 1 })).toEqual({
      records: [],
      cursor: { keep: 1 },
    });
    await expect(adapter.fetchRecord('posts', { id: 'x' })).rejects.toThrow(/lists no records/);
  });
});

describe('LinkedInPostsAdapter publish action', () => {
  it('publishes with the exact versioned-REST payload + headers and derives the permalink', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    const result = await adapter.runAction('publish', { text: 'Hello, professional world.' });

    expect(state.requests).toEqual(['https://api.linkedin.com/v2/userinfo']);
    expect(state.postCalls).toHaveLength(1);
    expect(state.postCalls[0]!.url).toBe('https://api.linkedin.com/rest/posts');
    expect(state.postCalls[0]!.accessToken).toBe('tok-1');
    expect(state.postCalls[0]!.headers).toEqual({
      'LinkedIn-Version': '202508',
      'X-Restli-Protocol-Version': '2.0.0',
    });
    expect(state.postCalls[0]!.body).toEqual({
      author: `urn:li:person:${SUB}`,
      commentary: 'Hello, professional world.',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    expect(result).toEqual({
      id: POST_URN,
      permalink: `https://www.linkedin.com/feed/update/${POST_URN}/`,
    });
  });

  it('a sub cached in the binding cursor (scoped envelope) skips the userinfo read', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true }, cred(), {
      v: 2,
      scopes: { posts: { sub: SUB } },
    });
    await adapter.runAction('publish', { text: 'No extra reads.' });
    expect(state.requests).toEqual([]);
    expect((state.postCalls[0]!.body as { author: string }).author).toBe(`urn:li:person:${SUB}`);
  });

  it('rejects a draft over the 3000-character ceiling without posting', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    await expect(adapter.runAction('publish', { text: 'a'.repeat(3001) })).rejects.toThrow(
      /limited to 3000 characters.*3001/,
    );
    expect(state.postCalls).toEqual([]);
    expect(state.requests).toEqual([]);
    // Exactly at the ceiling is fine.
    await expect(adapter.runAction('publish', { text: 'a'.repeat(3000) })).resolves.toMatchObject({
      id: POST_URN,
    });
  });

  it('maps a 401 on publish to the reconnect error and a 429 to the retry message', async () => {
    const { adapter, state } = await readyAdapter({ allowPublish: true });
    state.postError = new LinkedInApiError(401, 'expired');
    await expect(adapter.runAction('publish', { text: 'hi' })).rejects.toThrow(
      /reconnect this LinkedIn account.*60 days/i,
    );
    state.postError = new LinkedInApiError(429, 'too many');
    await expect(adapter.runAction('publish', { text: 'hi' })).rejects.toThrow(
      /rate-limited.*commit it again/i,
    );
  });

  it('refuses to publish when the binding has not enabled publishing', async () => {
    const { adapter, state } = await readyAdapter();
    await expect(adapter.runAction('publish', { text: 'hi' })).rejects.toThrow(
      /Publishing is disabled on this LinkedIn connector/,
    );
    expect(state.postCalls).toEqual([]);
  });

  it('requires non-empty text and rejects undeclared actions', async () => {
    const { adapter } = await readyAdapter({ allowPublish: true });
    await expect(adapter.runAction('publish', 'plain string')).rejects.toThrow(/must be an object/);
    await expect(adapter.runAction('publish', { text: '   ' })).rejects.toThrow(
      /non-empty post text/,
    );
    await expect(adapter.runAction('delete', { id: 'x' })).rejects.toThrow(
      /declares no action 'delete'/,
    );
  });
});

describe('linkedInPermalink', () => {
  it('wraps any post URN in the feed-update URL', () => {
    expect(linkedInPermalink('urn:li:ugcPost:123')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:ugcPost:123/',
    );
  });
});
