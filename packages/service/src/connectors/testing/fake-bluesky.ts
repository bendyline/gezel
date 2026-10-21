/**
 * A stateful fake Bluesky PDS + AppView speaking XRPC through `FakeHttp`, so
 * the `bluesky-posts` adapter runs its REAL default runtime (`@atproto/api`'s
 * `AtpAgent` over `AdapterDeps.fetch`) against it.
 *
 * Modeled: app-password sign-in (`createSession`, rationed like the PDS: 30
 * per 5 minutes), refresh-token rotation (`refreshSession`, single use),
 * `getSession`, the author feed (newest-first on the AppView's sort key, with
 * time-based cursors so new posts never shift later pages), notifications,
 * profiles, and `createRecord` for publishing. Responses are lexicon-valid —
 * the SDK validates every XRPC output, so a malformed fake fails loudly — and
 * errors use the XRPC `{ error, message }` body.
 */

import { FakeHttp, type FakeRequest, json, status } from './fake-http.js';

/** The connector's default service, so a binding with stock config reaches the fake. */
export const BSKY_SERVICE = 'https://bsky.social';
/** A real CIDv1 (dag-cbor, sha-256): the SDK parses every `cid` it receives. */
const CID = 'bafyreiejfnsx2gwtjgoeh27pqlnrf7i5zqj3sssflva7qzpqvrv7bx7nhi';

interface FakeBskyPost {
  rkey: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  createdAt: string;
  indexedAt: string;
  likes: number;
  reposts: number;
  /** Set on a repost entry of someone else's post: when the account reposted it. */
  repostedAt?: string;
}

interface FakeNotification {
  rkey: string;
  reason: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  indexedAt: string;
}

export interface FakeBlueskyOptions {
  now?: Date;
  /** createSession calls allowed before the fake answers 429 (the PDS allows 30 per 5 min). */
  loginLimit?: number;
  /** PDS origin (default `https://bsky.social`). */
  service?: string;
}

export class FakeBluesky {
  readonly http = new FakeHttp();
  readonly service: string;
  now: Date;
  readonly did = 'did:plc:gezelfake0000000000000000';
  readonly handle = 'gezelfake.bsky.social';
  readonly appPassword = 'abcd-efgh-ijkl-mnop';
  followers = 42;
  follows = 17;
  /** createSession / refreshSession calls so far. */
  logins = 0;
  refreshes = 0;
  private readonly loginLimit: number;
  private revoked = false;
  private n = 0;
  private readonly access = new Set<string>();
  private readonly refresh = new Set<string>();
  private feed: FakeBskyPost[] = [];
  private notifications: FakeNotification[] = [];

  constructor(opts: FakeBlueskyOptions = {}) {
    this.now = opts.now ?? new Date('2026-08-31T22:00:00.000Z');
    this.loginLimit = opts.loginLimit ?? 30;
    this.service = opts.service ?? BSKY_SERVICE;
    this.install();
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  /** The account posts at the fake clock; returns the rkey. */
  addPost(text: string, opts: { likes?: number } = {}): string {
    const rkey = this.rkey();
    const at = this.now.toISOString();
    this.feed.push({
      rkey,
      authorDid: this.did,
      authorHandle: this.handle,
      text,
      createdAt: at,
      indexedAt: at,
      likes: opts.likes ?? 0,
      reposts: 0,
    });
    return rkey;
  }

  /** The account reposts someone else's post (skipped by the adapter). */
  addRepost(text: string): void {
    const at = this.now.toISOString();
    this.feed.push({
      rkey: this.rkey(),
      authorDid: 'did:plc:someoneelse00000000000000',
      authorHandle: 'someone.bsky.social',
      text,
      createdAt: '2026-07-01T00:00:00.000Z',
      indexedAt: '2026-07-01T00:00:01.000Z',
      likes: 3,
      reposts: 1,
      repostedAt: at,
    });
  }

  addMention(text: string, reason = 'mention'): void {
    this.notifications.push({
      rkey: this.rkey(),
      reason,
      authorDid: 'did:plc:friend0000000000000000000',
      authorHandle: 'friend.bsky.social',
      text,
      indexedAt: this.now.toISOString(),
    });
  }

  setLikes(rkey: string, likes: number): void {
    const post = this.feed.find((p) => p.rkey === rkey);
    if (!post) throw new Error(`FakeBluesky has no post ${rkey}`);
    post.likes = likes;
  }

  deletePost(rkey: string): void {
    this.feed = this.feed.filter((p) => p.rkey !== rkey);
  }

  /** The account's own posts, newest first. */
  postRkeys(): string[] {
    return this.sortedFeed()
      .filter((p) => !p.repostedAt)
      .map((p) => p.rkey);
  }

  /** The app password is revoked: every session and refresh token dies with it. */
  revoke(): void {
    this.revoked = true;
    this.access.clear();
    this.refresh.clear();
  }

  private rkey(): string {
    // TID-shaped record keys sort by creation, as real ones do.
    return `3l${String(++this.n).padStart(11, '0')}`;
  }

  private mint(): { accessJwt: string; refreshJwt: string } {
    const n = ++this.n;
    const accessJwt = `access-${n}`;
    const refreshJwt = `refresh-${n}`;
    this.access.add(accessJwt);
    this.refresh.add(refreshJwt);
    return { accessJwt, refreshJwt };
  }

  private bearer(req: FakeRequest): string {
    return req.bearer ?? '';
  }

  private unauthorized(): Response {
    return status(401, { error: 'AuthenticationRequired', message: 'Authentication Required' });
  }

  private sortKey(p: FakeBskyPost): number {
    // The AppView sorts a post by the earlier of createdAt and indexedAt, and
    // a repost by when it was reposted.
    return p.repostedAt
      ? Date.parse(p.repostedAt)
      : Math.min(Date.parse(p.createdAt), Date.parse(p.indexedAt));
  }

  private sortedFeed(): FakeBskyPost[] {
    return [...this.feed].sort(
      (a, b) => this.sortKey(b) - this.sortKey(a) || (a.rkey < b.rkey ? 1 : -1),
    );
  }

  /** Time-based cursors (`<ms>::<rkey>`): a page is everything strictly older. */
  private page<T>(
    items: T[],
    key: (item: T) => [number, string],
    req: FakeRequest,
  ): { page: T[]; cursor?: string } {
    const q = req.url.searchParams;
    const limit = Math.max(1, Math.min(100, Number(q.get('limit') ?? '50') || 50));
    const cursor = q.get('cursor');
    let rest = items;
    if (cursor) {
      const [msRaw, rkey = ''] = cursor.split('::');
      const ms = Number(msRaw);
      rest = items.filter((item) => {
        const [m, k] = key(item);
        return m < ms || (m === ms && k < rkey);
      });
    }
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    return {
      page,
      ...(last && rest.length > page.length ? { cursor: key(last).join('::') } : {}),
    };
  }

  private author(did: string, handle: string) {
    return { did, handle, displayName: handle.split('.')[0] };
  }

  private postView(p: FakeBskyPost) {
    return {
      uri: `at://${p.authorDid}/app.bsky.feed.post/${p.rkey}`,
      cid: CID,
      author: this.author(p.authorDid, p.authorHandle),
      record: {
        $type: 'app.bsky.feed.post',
        text: p.text,
        createdAt: p.createdAt,
        langs: ['en'],
      },
      replyCount: 0,
      repostCount: p.reposts,
      likeCount: p.likes,
      quoteCount: 0,
      indexedAt: p.indexedAt,
    };
  }

  private install(): void {
    const xrpc = `${this.service}/xrpc`;
    this.http.on('POST', `${xrpc}/com.atproto.server.createSession`, (req) => {
      this.logins++;
      if (this.logins > this.loginLimit) {
        return status(429, { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' });
      }
      const body = req.json<{ identifier?: string; password?: string }>();
      const who = body.identifier === this.handle || body.identifier === this.did;
      if (this.revoked || !who || body.password !== this.appPassword) {
        return status(401, {
          error: 'AuthenticationRequired',
          message: 'Invalid identifier or password',
        });
      }
      return json({
        ...this.mint(),
        handle: this.handle,
        did: this.did,
        active: true,
      });
    });
    this.http.on('POST', `${xrpc}/com.atproto.server.refreshSession`, (req) => {
      this.refreshes++;
      const token = this.bearer(req);
      if (!this.refresh.has(token)) {
        return status(400, { error: 'ExpiredToken', message: 'Token has expired' });
      }
      // Single use, as on the PDS.
      this.refresh.delete(token);
      return json({ ...this.mint(), handle: this.handle, did: this.did, active: true });
    });
    this.http.on('GET', `${xrpc}/com.atproto.server.getSession`, (req) => {
      if (!this.access.has(this.bearer(req))) return this.unauthorized();
      return json({
        handle: this.handle,
        did: this.did,
        email: 'gezel@fake.test',
        emailConfirmed: true,
        active: true,
      });
    });
    this.http.on('GET', `${xrpc}/app.bsky.feed.getAuthorFeed`, (req) => {
      if (!this.access.has(this.bearer(req))) return this.unauthorized();
      const { page, cursor } = this.page(this.sortedFeed(), (p) => [this.sortKey(p), p.rkey], req);
      return json({
        feed: page.map((p) => ({
          post: this.postView(p),
          ...(p.repostedAt
            ? {
                reason: {
                  $type: 'app.bsky.feed.defs#reasonRepost',
                  by: this.author(this.did, this.handle),
                  indexedAt: p.repostedAt,
                },
              }
            : {}),
        })),
        ...(cursor ? { cursor } : {}),
      });
    });
    this.http.on('GET', `${xrpc}/app.bsky.notification.listNotifications`, (req) => {
      if (!this.access.has(this.bearer(req))) return this.unauthorized();
      const sorted = [...this.notifications].sort(
        (a, b) => Date.parse(b.indexedAt) - Date.parse(a.indexedAt),
      );
      const { page, cursor } = this.page(sorted, (n) => [Date.parse(n.indexedAt), n.rkey], req);
      return json({
        notifications: page.map((n) => ({
          uri: `at://${n.authorDid}/app.bsky.feed.post/${n.rkey}`,
          cid: CID,
          author: this.author(n.authorDid, n.authorHandle),
          reason: n.reason,
          record: { $type: 'app.bsky.feed.post', text: n.text, createdAt: n.indexedAt },
          isRead: false,
          indexedAt: n.indexedAt,
        })),
        ...(cursor ? { cursor } : {}),
      });
    });
    this.http.on('GET', `${xrpc}/app.bsky.actor.getProfile`, (req) => {
      if (!this.access.has(this.bearer(req))) return this.unauthorized();
      return json({
        did: this.did,
        handle: this.handle,
        displayName: 'Gezel Fake',
        followersCount: this.followers,
        followsCount: this.follows,
        postsCount: this.postRkeys().length,
      });
    });
    this.http.on('POST', `${xrpc}/com.atproto.repo.createRecord`, (req) => {
      if (!this.access.has(this.bearer(req))) return this.unauthorized();
      const body = req.json<{ repo?: string; collection?: string; record?: { text?: string } }>();
      if (body.repo !== this.did || body.collection !== 'app.bsky.feed.post') {
        return status(400, { error: 'InvalidRequest', message: 'unexpected repo or collection' });
      }
      const rkey = this.addPost(body.record?.text ?? '');
      return json({ uri: `at://${this.did}/app.bsky.feed.post/${rkey}`, cid: CID });
    });
  }
}
