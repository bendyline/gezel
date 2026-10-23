/**
 * LinkedIn as a `native` connector adapter — publish-centric by necessity.
 * Reading a member's posts requires LinkedIn's restricted Community
 * Management partner program, which ordinary developer apps cannot join, so
 * this adapter never mirrors a timeline: the single `posts` scope ALWAYS
 * returns an empty batch, and the corpus holds only what Gezel itself did —
 * the `_meta.json` marker plus outbox receipts under `_actions/_sent/`.
 *
 * Publishing works with the ordinary `w_member_social` product: `runAction`
 * POSTs a text post to the versioned REST API and returns the created post
 * URN + permalink. Commits are consent-gated through the `social-publish`
 * scope exactly like bluesky-posts (allowPublish + per-post consent).
 *
 * Auth quirks, encoded honestly:
 * - LinkedIn has no public-client PKCE support and requires the client
 *   secret on the code exchange. Gezel's shared OAuth flow always sends the
 *   PKCE params anyway; LinkedIn ignores unknown params, so the flow works
 *   unchanged — the manifest just marks the secret as required.
 * - Ordinary apps get NO refresh token (refresh is partner-only); the access
 *   token itself is simply long-lived (~60 days). The manifest's
 *   `secretShape.longLived` makes completeOAuth persist
 *   `{accessToken, expiresAt, refreshMode: 'none'}`, and an expired token
 *   here surfaces an actionable "reconnect" error instead of a refresh
 *   attempt. A partner-shaped blob that does carry a refresh token is
 *   refreshed in place like x-posts.
 *
 * Commentary is LinkedIn's `little` text format, not plain text: reserved
 * characters such as parentheses and brackets must be backslash-escaped or
 * LinkedIn mangles the post (text from the first one onward goes missing).
 * The adapter escapes them, keeping `#hashtags`, so a draft publishes as
 * written.
 *
 * Construct-per-pass with an injectable runtime seam, mirroring x-posts. The
 * default runtime rides `AdapterDeps.fetch`, so the provider simulator drives
 * it end to end.
 */

import { isRateLimitStatus } from '@bendyline/gezel';
import {
  type OAuthEndpoints,
  type OAuthTokens,
  type RefreshTokenParams,
  isExpired,
  refreshToken,
} from '../oauth.js';
import { connectorSecretKey, registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';

const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
/**
 * LinkedIn's versioned REST API takes a YYYYMM `LinkedIn-Version` header and
 * SUNSETS each version about a year after release — a retired pin makes every
 * request fail with 426 NONEXISTENT_VERSION. 202610 is supported until about
 * October 2027. Bump deliberately (at least yearly) and retest the publish
 * payload: https://learn.microsoft.com/linkedin/marketing/versioning
 */
const LINKEDIN_VERSION = '202610';
/** LinkedIn's ceiling for post commentary, in characters. */
const MAX_POST_CHARS = 3000;
const LINKEDIN_ENDPOINTS: OAuthEndpoints = {
  authEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
  tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
  scopes: [],
};

interface LinkedInConfig {
  allowPublish: boolean;
}

interface LinkedInOAuthCred {
  accessToken: string;
  expiresAt?: string;
  /** `'none'` — the ordinary long-lived shape completeOAuth persists when
   *  LinkedIn (as usual) returns no refresh token. */
  refreshMode?: string;
  /** Present only for approved-partner apps (standard credential shape). */
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

/** A non-2xx api.linkedin.com response; `status` drives the error mapping. */
export class LinkedInApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`linkedin api ${status}: ${detail}`.trim());
    this.name = 'LinkedInApiError';
  }
}

/** The slice of the outside world the adapter consumes (injectable for tests). */
export interface LinkedInRuntime {
  /** GET a JSON API URL with a bearer token; parsed JSON out; LinkedInApiError on !ok. */
  getJson(url: string, accessToken: string): Promise<unknown>;
  /**
   * POST a JSON body with a bearer token + the given headers. Returns the
   * created entity URN from the `x-restli-id` response header (LinkedIn's
   * create contract); LinkedInApiError on !ok.
   */
  postJson(
    url: string,
    accessToken: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ urn: string }>;
  /** OAuth refresh through the shared connector OAuth core (partner blobs only). */
  refreshToken(params: RefreshTokenParams): Promise<OAuthTokens>;
  now(): Date;
}

/** The production runtime over a transport (`AdapterDeps.fetch`, else global fetch). */
export function createLinkedInRuntime(fetchImpl: typeof fetch = fetch): LinkedInRuntime {
  return {
    getJson: async (url, accessToken) => {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new LinkedInApiError(res.status, text.slice(0, 300));
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return {};
      }
    },
    postJson: async (url, accessToken, headers, body) => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new LinkedInApiError(res.status, text.slice(0, 300));
      return { urn: res.headers.get('x-restli-id') ?? '' };
    },
    refreshToken: (params) => refreshToken({ ...params, fetchImpl }),
    now: () => new Date(),
  };
}

interface PostsCursor {
  /** OpenID `sub` of the signed-in member — the `<sub>` of `urn:li:person:<sub>`. */
  sub?: string;
}

/** `https://www.linkedin.com/feed/update/<urn>/` for any post/share URN. */
export function linkedInPermalink(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

export class LinkedInPostsAdapter implements ConnectorAdapter {
  readonly typeId = 'linkedin-posts';
  private config?: LinkedInConfig;
  private token = '';
  /** Per-pass memo of the member id, so one pass never reads userinfo twice. */
  private sub?: string;
  private readonly runtime: LinkedInRuntime;

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    runtime?: LinkedInRuntime,
  ) {
    this.runtime = runtime ?? createLinkedInRuntime(deps.fetch);
  }

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const key = connectorSecretKey(this.binding.type, this.binding.id);
    const blob = await this.deps.secrets.get(key);
    if (!blob) {
      throw new Error(
        `No stored credential for LinkedIn connector ${this.binding.id}. Re-link the account from the connector's settings.`,
      );
    }
    let cred: LinkedInOAuthCred;
    try {
      cred = JSON.parse(blob) as LinkedInOAuthCred;
    } catch {
      throw new Error(
        `The stored LinkedIn credential for ${this.binding.id} is unreadable. Re-link the account.`,
      );
    }
    if (!cred.accessToken) {
      throw new Error(
        `The stored LinkedIn credential for ${this.binding.id} has no access token. Re-link the account.`,
      );
    }
    if (isExpired(cred)) {
      if (cred.refreshMode === 'none' || !cred.refreshToken || !cred.clientId) {
        throw reconnectError();
      }
      // Approved-partner blobs carry a refresh token in the standard shape;
      // refresh + re-persist like x-posts so a rotated token is never lost.
      let t: OAuthTokens;
      try {
        t = await this.runtime.refreshToken({
          endpoints: LINKEDIN_ENDPOINTS,
          clientId: cred.clientId,
          ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
          refreshToken: cred.refreshToken,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (/invalid_grant|invalid_request|revoked|expired|unauthorized_client/i.test(detail)) {
          throw reconnectError();
        }
        throw err;
      }
      cred = {
        ...cred,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      };
      await this.deps.secrets.set(key, JSON.stringify(cred));
    }
    this.token = cred.accessToken;
  }

  async listScopes(): Promise<string[]> {
    this.assertReady();
    return ['posts'];
  }

  /**
   * ALWAYS an empty batch: LinkedIn restricts member-post reads to its
   * partner program, so the corpus is publish receipts only. The pass still
   * pins the member id into the cursor — one userinfo read, first pass only —
   * so later publishes can skip that read. The engine persists a returned
   * cursor even when the batch is empty (manager.ts `syncWithAdapter`
   * advances the scope cursor on any zero-error batch, and
   * `syncBindingInner` → `persistBinding` writes it whenever
   * `cursor !== undefined`), which is what makes the pin durable.
   */
  async listChangesSince(
    scope: string,
    cursor: unknown,
    _opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    this.assertReady();
    if (scope !== 'posts') return { records: [], cursor };
    const prior = parsePostsCursor(cursor);
    if (prior?.sub) return { records: [], cursor: prior };
    try {
      return { records: [], cursor: { sub: await this.fetchSub() } };
    } catch (err) {
      if (err instanceof LinkedInApiError && isRateLimitStatus(err.status)) {
        return { records: [], cursor, rateLimited: true };
      }
      if (err instanceof LinkedInApiError && err.status === 401) throw reconnectError();
      throw err;
    }
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    throw new Error(
      `linkedin-posts lists no records (LinkedIn restricts feed reads to its partner program); nothing to fetch for '${ref.id}'`,
    );
  }

  async runAction(action: string, input: unknown): Promise<unknown> {
    const config = this.assertReady();
    if (action !== 'publish') {
      throw new Error(`linkedin-posts declares no action '${action}'`);
    }
    // The social-publish consent enforcer already gates the commit; this is
    // defense-in-depth for any future non-outbox caller.
    if (!config.allowPublish) {
      throw new Error(
        "Publishing is disabled on this LinkedIn connector. Enable 'Allow publishing' in the connector's settings first.",
      );
    }
    const text = parsePublishInput(input);
    const chars = [...text].length;
    if (chars > MAX_POST_CHARS) {
      throw new Error(
        `LinkedIn posts are limited to ${MAX_POST_CHARS} characters; this draft is ${chars}. Shorten the text and draft again.`,
      );
    }
    try {
      // The member id pinned into the binding's persisted posts cursor (by a
      // prior sync pass) saves the userinfo read on repeat publishes.
      const sub = cachedSub(this.binding.cursor) ?? (await this.fetchSub());
      const { urn } = await this.runtime.postJson(
        POSTS_URL,
        this.token,
        {
          'LinkedIn-Version': LINKEDIN_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
        {
          author: `urn:li:person:${sub}`,
          commentary: escapeLittleText(text),
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        },
      );
      if (!urn) {
        throw new Error(
          'LinkedIn accepted the post but returned no x-restli-id header; check the post on linkedin.com before retrying.',
        );
      }
      return { id: urn, permalink: linkedInPermalink(urn) };
    } catch (err) {
      if (err instanceof LinkedInApiError && err.status === 401) throw reconnectError();
      if (err instanceof LinkedInApiError && isRateLimitStatus(err.status)) {
        throw new Error(
          'LinkedIn rate-limited this publish (member posting caps apply). The draft is unchanged — wait a while and commit it again.',
        );
      }
      if (err instanceof LinkedInApiError && isRetiredVersion(err)) {
        throw new Error(
          `LinkedIn has retired the API version this build of Gezel uses (${LINKEDIN_VERSION}), so it refuses every post. The draft is unchanged — update Gezel, then commit it again.`,
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {}

  private assertReady(): LinkedInConfig {
    if (!this.config || !this.token) {
      throw new Error('LinkedIn connector has not been initialized.');
    }
    return this.config;
  }

  /** The signed-in member's OpenID `sub` via `GET /v2/userinfo` (openid scope). */
  private async fetchSub(): Promise<string> {
    if (this.sub) return this.sub;
    const res = (await this.runtime.getJson(USERINFO_URL, this.token)) as { sub?: unknown };
    const sub = typeof res?.sub === 'string' ? res.sub : '';
    if (!sub) {
      throw new Error(
        'LinkedIn /v2/userinfo returned no member id (sub); cannot resolve the author URN for this binding.',
      );
    }
    this.sub = sub;
    return sub;
  }
}

/** The actionable expiry error — reconnecting is the only fix for ordinary apps. */
function reconnectError(): Error {
  return new Error(
    'The LinkedIn access token has expired or was revoked, and LinkedIn issues no refresh token to ordinary apps — reconnect this LinkedIn account from the connector settings (tokens last about 60 days).',
  );
}

/** 426 NONEXISTENT_VERSION (or VERSION_MISSING): the pinned version header is not served. */
function isRetiredVersion(err: LinkedInApiError): boolean {
  return err.status === 426 || /NONEXISTENT_VERSION|VERSION_MISSING/.test(err.message);
}

/** Characters LinkedIn's `little` format reserves; each needs a backslash to stay literal. */
const LITTLE_RESERVED = /[\\|{}@[\]()<>#*_~]/g;

/**
 * Escape plain text for a Posts API `commentary`. Unescaped reserved
 * characters are parsed as markup, and LinkedIn drops what it cannot render
 * (text after a stray `(` goes missing). A `#` that starts a word stays a
 * hashtag, which is what a person typing one means; every other reserved
 * character, including a `#` inside a word (`C#`), becomes literal.
 * https://learn.microsoft.com/linkedin/marketing/community-management/shares/little-text-format
 */
export function escapeLittleText(text: string): string {
  return text.replace(LITTLE_RESERVED, (ch, offset: number) => {
    if (ch === '#') {
      const before = offset > 0 ? text[offset - 1]! : '';
      const after = text[offset + 1] ?? '';
      const startsWord = !before || /\s/.test(before);
      if (startsWord && /[\p{L}\p{N}]/u.test(after)) return ch;
    }
    return `\\${ch}`;
  });
}

function parseConfig(raw: Record<string, unknown> | undefined): LinkedInConfig {
  return { allowPublish: raw?.allowPublish === true };
}

function parsePostsCursor(raw: unknown): PostsCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { sub?: unknown };
  return typeof value.sub === 'string' && value.sub ? { sub: value.sub } : undefined;
}

/**
 * The member id from the binding's PERSISTED cursor. `runAction` sees the
 * engine's scoped envelope (`{v: 2, scopes: {posts: {sub}}}`) — not the bare
 * per-scope cursor `listChangesSince` is handed — so unwrap it here.
 */
function cachedSub(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const envelope = raw as { v?: unknown; scopes?: unknown };
  if (envelope.v !== 2 || !envelope.scopes || typeof envelope.scopes !== 'object') {
    return undefined;
  }
  return parsePostsCursor((envelope.scopes as Record<string, unknown>).posts)?.sub;
}

function parsePublishInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    throw new Error('publish input must be an object with a text field');
  }
  const text = (input as { text?: unknown }).text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('publish requires non-empty post text');
  }
  return text;
}

/** Register the LinkedIn native adapter. */
export function registerLinkedInAdapters(): void {
  registerNativeAdapter('linkedin-posts', async (binding, deps) =>
    Promise.resolve(new LinkedInPostsAdapter(binding, deps)),
  );
}
