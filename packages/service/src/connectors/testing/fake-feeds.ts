/**
 * A fake web of feeds for the `rss-feed` connector: publishers whose
 * documents change between passes, served the way real feed hosts serve
 * them — RSS 2.0 with the content/dc/media modules, Atom 1.0, RSS 1.0 (RDF)
 * and JSON Feed 1.1, each with `ETag` and `Last-Modified` validators and a
 * 304 for a conditional GET that matches.
 *
 * Beyond well-formed feeds it can serve whatever a hostile or broken host
 * does: an arbitrary body (a web page with `<link rel="alternate">`, a
 * truncated document, an XXE probe), redirects, and error statuses. Faults
 * (429, 503) go through `FakeHttp.failNext`, like every other fake here.
 */

import type { FakeHttp, FakeRequest } from './fake-http.js';

export type FakeFeedFormat = 'rss' | 'atom' | 'rdf' | 'json';

export interface FakeFeedItem {
  /** Stable identity: RSS guid, Atom id, JSON Feed id, RDF rdf:about. */
  guid: string;
  title?: string;
  link?: string;
  /** Plain-text summary (RSS description, Atom summary, JSON content_text). */
  description?: string;
  /** Full HTML body (content:encoded, Atom content, JSON content_html). */
  contentHtml?: string;
  /** ISO 8601. */
  date?: string;
  author?: string;
  categories?: string[];
  enclosure?: { url: string; type: string; length: number };
  thumbnail?: string;
}

interface FeedState {
  url: string;
  format: FakeFeedFormat;
  title: string;
  link: string;
  items: FakeFeedItem[];
  version: number;
  etag: boolean;
  lastModified: boolean;
}

type Served =
  | { kind: 'feed'; state: FeedState }
  | {
      kind: 'raw';
      body: string | Uint8Array;
      contentType: string;
      status: number;
      headers?: Record<string, string>;
    }
  | { kind: 'redirect'; location: string; status: number };

const BASE_TIME = Date.parse('2026-10-01T00:00:00.000Z');

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CDATA that survives a body containing `]]>`. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

const rfc822 = (iso: string) => new Date(iso).toUTCString();

export class FakeFeedServer {
  /** Every request a feed route answered, with the validators it carried. */
  readonly requests: {
    url: string;
    status: number;
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    userAgent?: string;
  }[] = [];
  private readonly served = new Map<string, Served>();
  private readonly routed = new Set<string>();

  constructor(private readonly http: FakeHttp) {}

  /** Publish a feed at `url`. */
  feed(
    url: string,
    init: {
      format: FakeFeedFormat;
      title?: string;
      link?: string;
      items?: FakeFeedItem[];
      /** Send an ETag (default true). */
      etag?: boolean;
      /** Send Last-Modified (default true). */
      lastModified?: boolean;
    },
  ): this {
    this.serve(url, {
      kind: 'feed',
      state: {
        url,
        format: init.format,
        title: init.title ?? `Feed at ${new URL(url).hostname}`,
        link: init.link ?? new URL(url).origin,
        items: [...(init.items ?? [])],
        version: 1,
        etag: init.etag ?? true,
        lastModified: init.lastModified ?? true,
      },
    });
    return this;
  }

  /** A new item at the top of the feed (publishers prepend). */
  addItem(url: string, item: FakeFeedItem): this {
    const state = this.state(url);
    state.items.unshift(item);
    state.version++;
    return this;
  }

  /** Edit an item in place (same guid). */
  updateItem(url: string, guid: string, patch: Partial<FakeFeedItem>): this {
    const state = this.state(url);
    const item = state.items.find((i) => i.guid === guid);
    if (!item) throw new Error(`fake feed ${url} has no item ${guid}`);
    Object.assign(item, patch);
    state.version++;
    return this;
  }

  /** Drop the oldest items, as a publisher trimming its window does. */
  trim(url: string, keep: number): this {
    const state = this.state(url);
    state.items = state.items.slice(0, keep);
    state.version++;
    return this;
  }

  /** Serve an arbitrary body (a web page, a broken document, a probe). */
  raw(
    url: string,
    body: string | Uint8Array,
    contentType = 'application/xml',
    opts: { status?: number; headers?: Record<string, string> } = {},
  ): this {
    this.serve(url, {
      kind: 'raw',
      body,
      contentType,
      status: opts.status ?? 200,
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    return this;
  }

  redirect(from: string, location: string, code = 301): this {
    this.serve(from, { kind: 'redirect', location, status: code });
    return this;
  }

  items(url: string): FakeFeedItem[] {
    return this.state(url).items;
  }

  /** The document as currently served. */
  render(url: string): string {
    return renderFeed(this.state(url));
  }

  private state(url: string): FeedState {
    const s = this.served.get(url);
    if (s?.kind !== 'feed') throw new Error(`no fake feed at ${url}`);
    return s.state;
  }

  private serve(url: string, what: Served): void {
    this.served.set(url, what);
    const u = new URL(url);
    const route = `${u.origin}${u.pathname}`;
    if (this.routed.has(route)) return;
    this.routed.add(route);
    // FakeHttp routes ignore the query string; feeds such as
    // `videos.xml?channel_id=…` differ only there, so dispatch on the full URL.
    this.http.on('GET', route, (req) => this.answer(req));
  }

  private answer(req: FakeRequest): Response {
    const full = `${req.url.origin}${req.url.pathname}${req.url.search}`;
    const what = this.served.get(full) ?? this.served.get(`${req.url.origin}${req.url.pathname}`);
    const record = (code: number) => {
      const inm = req.headers.get('if-none-match');
      const ims = req.headers.get('if-modified-since');
      const ua = req.headers.get('user-agent');
      this.requests.push({
        url: full,
        status: code,
        ...(inm ? { ifNoneMatch: inm } : {}),
        ...(ims ? { ifModifiedSince: ims } : {}),
        ...(ua ? { userAgent: ua } : {}),
      });
    };
    if (!what) {
      record(404);
      return new Response('<html><body>Not found</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (what.kind === 'redirect') {
      record(what.status);
      return new Response(null, { status: what.status, headers: { location: what.location } });
    }
    if (what.kind === 'raw') {
      record(what.status);
      return new Response(typeof what.body === 'string' ? what.body : Buffer.from(what.body), {
        status: what.status,
        headers: { 'content-type': what.contentType, ...what.headers },
      });
    }
    const state = what.state;
    const etag = `"v${state.version}-${state.items.length}"`;
    const modified = new Date(BASE_TIME + state.version * 60_000).toUTCString();
    const inm = req.headers.get('if-none-match');
    const ims = req.headers.get('if-modified-since');
    const notModified =
      (state.etag && inm !== null && inm === etag) ||
      (state.lastModified &&
        inm === null &&
        ims !== null &&
        Date.parse(ims) >= Date.parse(modified));
    const headers: Record<string, string> = {
      ...(state.etag ? { etag } : {}),
      ...(state.lastModified ? { 'last-modified': modified } : {}),
    };
    if (notModified) {
      record(304);
      return new Response(null, { status: 304, headers });
    }
    record(200);
    const contentType =
      state.format === 'json'
        ? 'application/feed+json'
        : state.format === 'atom'
          ? 'application/atom+xml; charset=utf-8'
          : state.format === 'rdf'
            ? 'application/rdf+xml'
            : 'application/rss+xml; charset=utf-8';
    return new Response(renderFeed(state), {
      status: 200,
      headers: { 'content-type': contentType, ...headers },
    });
  }
}

function renderFeed(state: FeedState): string {
  switch (state.format) {
    case 'atom':
      return renderAtom(state);
    case 'rdf':
      return renderRdf(state);
    case 'json':
      return renderJson(state);
    default:
      return renderRss(state);
  }
}

function renderRss(state: FeedState): string {
  const items = state.items
    .map((i) =>
      [
        '    <item>',
        i.title !== undefined ? `      <title>${esc(i.title)}</title>` : '',
        i.link ? `      <link>${esc(i.link)}</link>` : '',
        `      <guid isPermaLink="false">${esc(i.guid)}</guid>`,
        i.date ? `      <pubDate>${rfc822(i.date)}</pubDate>` : '',
        i.author ? `      <dc:creator>${cdata(i.author)}</dc:creator>` : '',
        ...(i.categories ?? []).map((c) => `      <category>${cdata(c)}</category>`),
        i.description !== undefined ? `      <description>${esc(i.description)}</description>` : '',
        i.contentHtml ? `      <content:encoded>${cdata(i.contentHtml)}</content:encoded>` : '',
        i.enclosure
          ? `      <enclosure url="${esc(i.enclosure.url)}" length="${i.enclosure.length}" type="${esc(i.enclosure.type)}"/>`
          : '',
        i.thumbnail ? `      <media:thumbnail url="${esc(i.thumbnail)}"/>` : '',
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(state.title)}</title>
    <link>${esc(state.link)}</link>
    <description>${esc(state.title)}</description>
    <atom:link href="${esc(state.url)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

function renderAtom(state: FeedState): string {
  const updated = state.items.find((i) => i.date)?.date ?? new Date(BASE_TIME).toISOString();
  const entries = state.items
    .map((i) =>
      [
        '  <entry>',
        i.title !== undefined ? `    <title type="html">${esc(i.title)}</title>` : '',
        i.link ? `    <link rel="alternate" type="text/html" href="${esc(i.link)}"/>` : '',
        `    <id>${esc(i.guid)}</id>`,
        i.date ? `    <published>${i.date}</published>\n    <updated>${i.date}</updated>` : '',
        i.author ? `    <author><name>${esc(i.author)}</name></author>` : '',
        ...(i.categories ?? []).map((c) => `    <category term="${esc(c)}"/>`),
        i.description !== undefined
          ? `    <summary type="text">${esc(i.description)}</summary>`
          : '',
        i.contentHtml ? `    <content type="html">${esc(i.contentHtml)}</content>` : '',
        i.enclosure
          ? `    <link rel="enclosure" type="${esc(i.enclosure.type)}" length="${i.enclosure.length}" href="${esc(i.enclosure.url)}"/>`
          : '',
        i.thumbnail ? `    <media:thumbnail url="${esc(i.thumbnail)}"/>` : '',
        '  </entry>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>${esc(state.title)}</title>
  <link rel="alternate" type="text/html" href="${esc(state.link)}"/>
  <link rel="self" type="application/atom+xml" href="${esc(state.url)}"/>
  <id>${esc(state.url)}</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

function renderRdf(state: FeedState): string {
  const seq = state.items
    .map((i) => `        <rdf:li rdf:resource="${esc(i.link ?? i.guid)}"/>`)
    .join('\n');
  const items = state.items
    .map((i) =>
      [
        `  <item rdf:about="${esc(i.link ?? i.guid)}">`,
        i.title !== undefined ? `    <title>${esc(i.title)}</title>` : '',
        i.link ? `    <link>${esc(i.link)}</link>` : '',
        i.description !== undefined ? `    <description>${esc(i.description)}</description>` : '',
        i.contentHtml ? `    <content:encoded>${cdata(i.contentHtml)}</content:encoded>` : '',
        i.date ? `    <dc:date>${i.date}</dc:date>` : '',
        i.author ? `    <dc:creator>${esc(i.author)}</dc:creator>` : '',
        ...(i.categories ?? []).map((c) => `    <dc:subject>${esc(c)}</dc:subject>`),
        '  </item>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="${esc(state.url)}">
    <title>${esc(state.title)}</title>
    <link>${esc(state.link)}</link>
    <description>${esc(state.title)}</description>
    <items>
      <rdf:Seq>
${seq}
      </rdf:Seq>
    </items>
  </channel>
${items}
</rdf:RDF>
`;
}

function renderJson(state: FeedState): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: state.title,
      home_page_url: state.link,
      feed_url: state.url,
      items: state.items.map((i) => ({
        id: i.guid,
        ...(i.link ? { url: i.link } : {}),
        ...(i.title !== undefined ? { title: i.title } : {}),
        ...(i.contentHtml ? { content_html: i.contentHtml } : {}),
        ...(i.description !== undefined
          ? i.contentHtml
            ? { summary: i.description }
            : { content_text: i.description }
          : {}),
        ...(i.date ? { date_published: i.date } : {}),
        ...(i.author ? { authors: [{ name: i.author }] } : {}),
        ...(i.categories ? { tags: i.categories } : {}),
        ...(i.thumbnail ? { image: i.thumbnail } : {}),
        ...(i.enclosure
          ? {
              attachments: [
                {
                  url: i.enclosure.url,
                  mime_type: i.enclosure.type,
                  size_in_bytes: i.enclosure.length,
                },
              ],
            }
          : {}),
      })),
    },
    null,
    2,
  );
}
