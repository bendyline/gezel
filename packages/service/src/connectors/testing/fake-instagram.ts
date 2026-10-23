/**
 * A stateful fake of the Instagram API with Instagram Login
 * (graph.instagram.com) as the `instagram-media` adapter uses it, served
 * through `FakeHttp`: the account's media edge newest-first with Meta's
 * cursor paging (`paging.cursors.after` plus a `paging.next` link that embeds
 * the access token, exactly as Meta's do), the profile fields, the two-step
 * container publish, a media lookup for the permalink receipt, and the
 * long-lived token refresh (`ig_refresh_token`).
 *
 * Errors use Meta's `{ error: { message, type, code, fbtrace_id } }` body: a
 * dead token is OAuthException code 190, throttling a code such as 80002 (the
 * Instagram business-use-case cap). Any `vNN.0` version segment is accepted,
 * as Graph accepts every live version.
 */

import { FakeHttp, type FakeRequest, json, status } from './fake-http.js';

export const IG_GRAPH = 'https://graph.instagram.com';

interface FakeMedia {
  id: string;
  caption: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  timestamp: string;
  likes: number;
  comments: number;
}

export interface FakeInstagramOptions {
  now?: Date;
}

/** Meta's timestamp format: `2026-08-31T22:00:00+0000`. */
function metaTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}+0000`;
}

export class FakeInstagram {
  readonly http = new FakeHttp();
  now: Date;
  readonly userId = '17841400000000001';
  readonly username = 'gezelfake';
  followers = 2456;
  follows = 180;
  /** Graph versions requested so far (the adapter pins one). */
  readonly versions = new Set<string>();
  private readonly tokens = new Set<string>(['ig-seed']);
  private media: FakeMedia[] = [];
  private n = 0;
  private containers = new Map<string, { imageUrl: string; caption: string }>();

  constructor(opts: FakeInstagramOptions = {}) {
    this.now = opts.now ?? new Date('2026-08-31T22:00:00.000Z');
    this.install();
  }

  /** The blob `completeOAuth` stores after Meta's long-lived exchange. */
  credential(expiresInDays = 50): Record<string, string> {
    return {
      accessToken: 'ig-seed',
      expiresAt: new Date(this.now.getTime() + expiresInDays * 86_400_000).toISOString(),
      refreshMode: 'long-lived-exchange',
      refreshUrl: `${IG_GRAPH}/refresh_access_token`,
    };
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  addMedia(caption: string, opts: { likes?: number; type?: FakeMedia['mediaType'] } = {}): string {
    const id = `1790000000000${String(++this.n).padStart(4, '0')}`;
    this.media.push({
      id,
      caption,
      mediaType: opts.type ?? 'IMAGE',
      timestamp: metaTime(this.now),
      likes: opts.likes ?? 0,
      comments: 0,
    });
    return id;
  }

  editCaption(id: string, caption: string): void {
    this.find(id).caption = caption;
  }

  setLikes(id: string, likes: number): void {
    this.find(id).likes = likes;
  }

  deleteMedia(id: string): void {
    this.media = this.media.filter((m) => m.id !== id);
  }

  /** Media ids, newest first. */
  mediaIds(): string[] {
    return this.sorted().map((m) => m.id);
  }

  /** The person revoked the app (or changed their password): every token dies. */
  revoke(): void {
    this.tokens.clear();
  }

  private find(id: string): FakeMedia {
    const m = this.media.find((x) => x.id === id);
    if (!m) throw new Error(`FakeInstagram has no media ${id}`);
    return m;
  }

  private sorted(): FakeMedia[] {
    return [...this.media].sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || (a.id < b.id ? 1 : -1),
    );
  }

  private metaError(code: number, message: string, httpStatus = 400): Response {
    return status(httpStatus, {
      error: { message, type: 'OAuthException', code, fbtrace_id: 'AfakeTrace01' },
    });
  }

  private authorized(req: FakeRequest): Response | null {
    const token = req.url.searchParams.get('access_token') ?? req.form().get('access_token') ?? '';
    if (this.tokens.has(token)) return null;
    return this.metaError(
      190,
      'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.',
    );
  }

  private permalink(id: string): string {
    return `https://www.instagram.com/p/C${id.slice(-6)}x/`;
  }

  private view(m: FakeMedia, fields: Set<string>): Record<string, unknown> {
    const all: Record<string, unknown> = {
      id: m.id,
      caption: m.caption,
      media_type: m.mediaType,
      media_url: `https://scontent.cdninstagram.com/fake/${m.id}.jpg`,
      permalink: this.permalink(m.id),
      timestamp: m.timestamp,
      like_count: m.likes,
      comments_count: m.comments,
    };
    // Meta returns only the requested fields (plus the id).
    return Object.fromEntries(Object.entries(all).filter(([k]) => k === 'id' || fields.has(k)));
  }

  private mediaPage(req: FakeRequest, version: string): Response {
    const q = req.url.searchParams;
    const fields = new Set((q.get('fields') ?? '').split(',').filter(Boolean));
    const limit = Math.max(1, Math.min(100, Number(q.get('limit') ?? '25') || 25));
    const after = q.get('after');
    let rows = this.sorted();
    if (after) {
      const [msRaw, id = ''] = Buffer.from(after, 'base64url').toString('utf8').split('::');
      const ms = Number(msRaw);
      rows = rows.filter((m) => {
        const t = Date.parse(m.timestamp);
        return t < ms || (t === ms && m.id < id);
      });
    }
    const page = rows.slice(0, limit);
    const cursorOf = (m: FakeMedia) =>
      Buffer.from(`${Date.parse(m.timestamp)}::${m.id}`).toString('base64url');
    const more = rows.length > page.length;
    const next = new URL(`${IG_GRAPH}/${version}/me/media`);
    for (const [k, v] of q) if (k !== 'after') next.searchParams.set(k, v);
    if (page.length) next.searchParams.set('after', cursorOf(page.at(-1)!));
    return json({
      data: page.map((m) => this.view(m, fields)),
      ...(page.length
        ? {
            paging: {
              cursors: { before: cursorOf(page[0]!), after: cursorOf(page.at(-1)!) },
              ...(more ? { next: next.toString() } : {}),
            },
          }
        : {}),
    });
  }

  private install(): void {
    const version = (v: string) => /^v\d+\.0$/.test(v);
    // Registered before the `me` routes: later routes win in FakeHttp.
    this.http.on('GET', `${IG_GRAPH}/:version/:id`, (req, p) => {
      if (!version(p.version!)) return this.metaError(2500, 'Unknown path components');
      this.versions.add(p.version!);
      const denied = this.authorized(req);
      if (denied) return denied;
      const m = this.media.find((x) => x.id === p.id);
      if (!m) return this.metaError(100, 'Unsupported get request.');
      const fields = new Set((req.url.searchParams.get('fields') ?? '').split(','));
      return json(this.view(m, fields));
    });
    this.http.on('GET', `${IG_GRAPH}/:version/me`, (req, p) => {
      if (!version(p.version!)) return this.metaError(2500, 'Unknown path components');
      this.versions.add(p.version!);
      const denied = this.authorized(req);
      if (denied) return denied;
      const fields = new Set((req.url.searchParams.get('fields') ?? '').split(','));
      const all: Record<string, unknown> = {
        id: this.userId,
        username: this.username,
        followers_count: this.followers,
        follows_count: this.follows,
        media_count: this.media.length,
      };
      return json(
        Object.fromEntries(Object.entries(all).filter(([k]) => k === 'id' || fields.has(k))),
      );
    });
    this.http.on('GET', `${IG_GRAPH}/:version/me/media`, (req, p) => {
      if (!version(p.version!)) return this.metaError(2500, 'Unknown path components');
      this.versions.add(p.version!);
      return this.authorized(req) ?? this.mediaPage(req, p.version!);
    });
    this.http.on('POST', `${IG_GRAPH}/:version/me/media`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      const form = req.form();
      const imageUrl = form.get('image_url') ?? '';
      if (!imageUrl.startsWith('https://')) {
        return this.metaError(9004, 'Only photo or video can be accepted as media type.');
      }
      const id = `1800000000000${String(++this.n).padStart(4, '0')}`;
      this.containers.set(id, { imageUrl, caption: form.get('caption') ?? '' });
      return json({ id });
    });
    this.http.on('POST', `${IG_GRAPH}/:version/me/media_publish`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      const container = this.containers.get(req.form().get('creation_id') ?? '');
      if (!container) return this.metaError(100, 'Invalid parameter');
      return json({ id: this.addMedia(container.caption) });
    });
    this.http.on('GET', `${IG_GRAPH}/refresh_access_token`, (req) => {
      const q = req.url.searchParams;
      const token = q.get('access_token') ?? '';
      if (q.get('grant_type') !== 'ig_refresh_token' || !this.tokens.has(token)) {
        return this.metaError(190, 'Error validating access token: Session has expired.');
      }
      const next = `ig-refreshed-${++this.n}`;
      this.tokens.add(next);
      return json({ access_token: next, token_type: 'bearer', expires_in: 5_184_000 });
    });
  }
}
