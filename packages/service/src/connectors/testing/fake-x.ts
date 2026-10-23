/**
 * A stateful fake of the X API v2 surface the `x-posts` adapter uses, served
 * through `FakeHttp`: the account's own timeline and mentions with since_id /
 * until_id / start_time windows and `meta.next_token` paging, `/2/users/me`,
 * `POST /2/tweets`, and the OAuth 2.0 token endpoint with refresh-token
 * rotation (X rotates on every refresh).
 *
 * Shapes follow the live API: every post carries `id`, `text` and
 * `edit_history_tweet_ids` (oldest first); other fields appear only when
 * `tweet.fields` asks for them; an empty page is `{ meta: { result_count: 0 } }`;
 * errors are RFC 7807 problem bodies. Ids are real snowflakes minted from the
 * fake clock, so their order is their age. An edit mints a new id and the
 * timelines return only the newest version, as X does.
 */

import { FakeHttp, type FakeRequest, FakeTokenEndpoint, json, status } from './fake-http.js';

export const X_API = 'https://api.x.com/2';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const SNOWFLAKE_EPOCH = 1288834974657n;

interface FakePost {
  /** Every version's id, oldest first; the last is the live one. */
  versions: string[];
  text: string;
  createdAt: string;
  authorId: string;
  inReplyTo?: string;
  likes: number;
  reposts: number;
  views: number;
}

export interface FakeXOptions {
  now?: Date;
  userId?: string;
  username?: string;
}

export class FakeX {
  readonly http = new FakeHttp();
  readonly tokens = new FakeTokenEndpoint(X_TOKEN_URL, {
    rotateRefreshToken: true,
    expiresIn: 7200,
  });
  now: Date;
  readonly userId: string;
  readonly username: string;
  followers = 120;
  following = 80;
  /** When set, every bearer is refused (a revoked grant). */
  revoked = false;
  private posts: FakePost[] = [];
  private mentions: FakePost[] = [];
  private readonly users = new Map<string, string>();
  private seq = 0n;

  constructor(opts: FakeXOptions = {}) {
    this.now = opts.now ?? new Date('2026-08-31T22:00:00.000Z');
    this.userId = opts.userId ?? '9001';
    this.username = opts.username ?? 'gezelfake';
    this.users.set(this.userId, this.username);
    this.tokens.install(this.http);
    this.install();
  }

  /** A credential blob as `completeOAuth` stores it for an oauth2 type. */
  credential(): Record<string, string> {
    return {
      accessToken: 'access-seed',
      refreshToken: this.tokens.issueRefreshToken(),
      expiresAt: '2999-01-01T00:00:00.000Z',
      clientId: 'x-client',
    };
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  /** Publish a post as the account at the fake clock; returns its id. */
  addPost(text: string, opts: { likes?: number; inReplyTo?: string } = {}): string {
    const id = this.mint();
    this.posts.push({
      versions: [id],
      text,
      createdAt: this.now.toISOString(),
      authorId: this.userId,
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      likes: opts.likes ?? 0,
      reposts: 0,
      views: 10,
    });
    return id;
  }

  /** Someone else mentions the account; returns the post id. */
  addMention(text: string, author: { id: string; username: string }): string {
    this.users.set(author.id, author.username);
    const id = this.mint();
    this.mentions.push({
      versions: [id],
      text,
      createdAt: this.now.toISOString(),
      authorId: author.id,
      likes: 0,
      reposts: 0,
      views: 0,
    });
    return id;
  }

  /** Edit a post: X mints a new version id dated now; returns it. */
  editPost(anyVersionId: string, text: string): string {
    const post = this.find(anyVersionId);
    const id = this.mint();
    post.versions.push(id);
    post.text = text;
    post.createdAt = this.now.toISOString();
    return id;
  }

  setLikes(anyVersionId: string, likes: number): void {
    this.find(anyVersionId).likes = likes;
  }

  deletePost(anyVersionId: string): void {
    this.posts = this.posts.filter((p) => !p.versions.includes(anyVersionId));
  }

  /** The original id of every live post, newest first. */
  postIds(): string[] {
    return this.sorted(this.posts).map((p) => p.versions[0]!);
  }

  revoke(): void {
    this.revoked = true;
    this.tokens.rejectRefresh = true;
  }

  private find(anyVersionId: string): FakePost {
    const post = this.posts.find((p) => p.versions.includes(anyVersionId));
    if (!post) throw new Error(`FakeX has no post ${anyVersionId}`);
    return post;
  }

  private mint(): string {
    const ms = BigInt(this.now.getTime()) - SNOWFLAKE_EPOCH;
    this.seq = (this.seq + 1n) & 0x3fffffn;
    return String((ms << 22n) | this.seq);
  }

  private sorted(list: FakePost[]): FakePost[] {
    const live = (p: FakePost) => BigInt(p.versions.at(-1)!);
    return [...list].sort((a, b) => (live(b) > live(a) ? 1 : live(b) < live(a) ? -1 : 0));
  }

  private authorized(req: FakeRequest): Response | null {
    if (!this.revoked && req.bearer?.startsWith('access-')) return null;
    return status(401, {
      title: 'Unauthorized',
      type: 'about:blank',
      status: 401,
      detail: 'Unauthorized',
    });
  }

  private render(
    post: FakePost,
    fields: Set<string>,
    withAuthor: boolean,
  ): Record<string, unknown> {
    const id = post.versions.at(-1)!;
    return {
      id,
      text: post.text,
      edit_history_tweet_ids: [...post.versions],
      ...(fields.has('created_at') ? { created_at: post.createdAt } : {}),
      ...(fields.has('lang') ? { lang: 'en' } : {}),
      ...(fields.has('referenced_tweets') && post.inReplyTo
        ? { referenced_tweets: [{ type: 'replied_to', id: post.inReplyTo }] }
        : {}),
      ...(fields.has('author_id') || withAuthor ? { author_id: post.authorId } : {}),
      ...(fields.has('public_metrics')
        ? {
            public_metrics: {
              retweet_count: post.reposts,
              reply_count: 0,
              like_count: post.likes,
              quote_count: 0,
              bookmark_count: 0,
              impression_count: post.views,
            },
          }
        : {}),
    };
  }

  private timeline(req: FakeRequest, list: FakePost[]): Response {
    const q = req.url.searchParams;
    const max = Number(q.get('max_results') ?? '10');
    if (!Number.isInteger(max) || max < 5 || max > 100) {
      return status(400, {
        errors: [
          {
            parameters: { max_results: [String(max)] },
            message: 'The `max_results` query parameter value is not between 5 and 100',
          },
        ],
        title: 'Invalid Request',
        detail: 'One or more parameters to your request was invalid.',
        type: 'https://api.twitter.com/2/problems/invalid-request',
      });
    }
    const sinceId = q.get('since_id');
    const untilId = q.get('until_id');
    if (sinceId && untilId && BigInt(sinceId) >= BigInt(untilId)) {
      return status(400, {
        title: 'Invalid Request',
        detail: 'since_id must be less than until_id',
        type: 'https://api.twitter.com/2/problems/invalid-request',
      });
    }
    const startTime = q.get('start_time');
    const fields = new Set((q.get('tweet.fields') ?? '').split(',').filter(Boolean));
    let rows = this.sorted(list).filter((p) => {
      const id = BigInt(p.versions.at(-1)!);
      if (sinceId && id <= BigInt(sinceId)) return false;
      if (untilId && id >= BigInt(untilId)) return false;
      if (startTime && Date.parse(p.createdAt) < Date.parse(startTime)) return false;
      return true;
    });
    const offset = Number(q.get('pagination_token') ?? '0') || 0;
    rows = rows.slice(offset);
    const page = rows.slice(0, max);
    if (page.length === 0) return json({ meta: { result_count: 0 } });
    const expandAuthors = q.get('expansions')?.includes('author_id') ?? false;
    const data = page.map((p) => this.render(p, fields, expandAuthors));
    const authors = expandAuthors
      ? [...new Set(page.map((p) => p.authorId))].map((id) => ({
          id,
          name: this.users.get(id) ?? id,
          username: this.users.get(id) ?? id,
        }))
      : [];
    return json({
      data,
      ...(authors.length ? { includes: { users: authors } } : {}),
      meta: {
        result_count: data.length,
        newest_id: data[0]!.id,
        oldest_id: data.at(-1)!.id,
        ...(rows.length > page.length ? { next_token: String(offset + page.length) } : {}),
      },
    });
  }

  private install(): void {
    this.http.on('GET', `${X_API}/users/me`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      const fields = req.url.searchParams.get('user.fields') ?? '';
      return json({
        data: {
          id: this.userId,
          name: 'Gezel Fake',
          username: this.username,
          ...(fields.includes('public_metrics')
            ? {
                public_metrics: {
                  followers_count: this.followers,
                  following_count: this.following,
                  tweet_count: this.posts.length,
                  listed_count: 0,
                  like_count: 0,
                },
              }
            : {}),
        },
      });
    });
    this.http.on('GET', `${X_API}/users/:id/tweets`, (req, p) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      return this.timeline(req, p.id === this.userId ? this.posts : []);
    });
    this.http.on('GET', `${X_API}/users/:id/mentions`, (req, p) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      return this.timeline(req, p.id === this.userId ? this.mentions : []);
    });
    this.http.on('POST', `${X_API}/tweets`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      const body = req.json<{ text?: string; reply?: { in_reply_to_tweet_id?: string } }>();
      if (!body.text) {
        return status(400, { title: 'Invalid Request', detail: 'text is required', status: 400 });
      }
      const id = this.addPost(body.text, {
        ...(body.reply?.in_reply_to_tweet_id ? { inReplyTo: body.reply.in_reply_to_tweet_id } : {}),
      });
      return json({ data: { id, text: body.text, edit_history_tweet_ids: [id] } }, { status: 201 });
    });
  }
}
