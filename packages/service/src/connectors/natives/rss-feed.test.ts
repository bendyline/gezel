import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { type FakeFeedItem, FakeFeedServer } from '../testing/fake-feeds.js';
import { FakeHttp, status } from '../testing/fake-http.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { ConnectorBindingRef, RecordRef } from '../types.js';
import {
  FEED_USER_AGENT,
  RssFeedAdapter,
  type RssFeedOptions,
  decodeFeedBytes,
  displayFeedUrl,
  feedScopeLabel,
  parseFeedDate,
  parseFeedDocument,
} from './rss-feed.js';

const BLOG = 'https://blog.example.test/feed.xml';
const NEWS = 'https://news.example.test/atom.xml';

function item(n: number, extra: Partial<FakeFeedItem> = {}): FakeFeedItem {
  return {
    guid: `urn:item:${n}`,
    title: `Post number ${n}`,
    link: `https://blog.example.test/posts/${n}`,
    description: `Summary of post ${n}.`,
    date: new Date(Date.parse('2026-10-01T09:00:00Z') + n * 3_600_000).toISOString(),
    author: 'Ada',
    ...extra,
  };
}

function binding(feeds: string[], extra: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'rss-1', type: 'rss-feed', config: { feeds, ...extra } };
}

describeConnectorConformance('rss-feed', {
  async create() {
    const env = await createConnectorTestEnv();
    const http = new FakeHttp();
    const feeds = new FakeFeedServer(http)
      .feed(BLOG, { format: 'rss', title: 'Example Blog', items: [item(3), item(2), item(1)] })
      .feed(NEWS, {
        format: 'atom',
        title: 'Example News',
        items: [
          item(11, { link: 'https://news.example.test/a/11' }),
          item(10, { link: 'https://news.example.test/a/10' }),
        ],
      });
    let next = 100;
    return {
      env,
      seeded: 5,
      requiredKeys: ['title', 'date', 'url', 'feed', 'feed_url'],
      unrouted: () => http.unrouted,
      adapter: async () =>
        new RssFeedAdapter(binding([BLOG, NEWS]), env.deps({ fetch: http.fetch })),
      hooks: {
        add: (n = 1) => {
          for (let i = 0; i < n; i++) feeds.addItem(BLOG, item(next++));
        },
        update: () => {
          feeds.updateItem(BLOG, 'urn:item:2', { description: 'An edited summary.' });
        },
        move: () => {
          feeds.updateItem(BLOG, 'urn:item:1', { date: '2026-08-15T12:00:00.000Z' });
        },
        throttleNextList: () => {
          http.failNext({ url: BLOG }, status(429, undefined, { 'retry-after': '30' }));
        },
        addHostile: () => {
          feeds.addItem(BLOG, {
            guid: HOSTILE_NAME,
            title: HOSTILE_NAME,
            link: 'https://blog.example.test/posts/hostile',
            description: INJECTION_PAYLOAD,
            date: '2026-10-05T10:00:00.000Z',
          });
        },
      },
    };
  },
});

// ── adapter behavior ───────────────────────────────────────────────────────

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

async function world(opts: RssFeedOptions = {}) {
  env = await createConnectorTestEnv();
  const http = new FakeHttp();
  const feeds = new FakeFeedServer(http);
  const e = env;
  let cursor: unknown;
  const adapter = (feedList: string[], extra: Record<string, unknown> = {}) =>
    new RssFeedAdapter(binding(feedList, extra), e.deps({ fetch: http.fetch }), opts);
  const pass = async (
    feedList: string[],
    extra: Record<string, unknown> = {},
    backfillLimit = 500,
  ) => {
    const r = await syncWithAdapter(adapter(feedList, extra), {
      storageDir: e.artifactsDir,
      quarantineDir: e.quarantineDir,
      corpusDir: 'data/feeds',
      backfillLimit,
      cursor,
    });
    cursor = r.cursor;
    return r;
  };
  return { http, feeds, adapter, pass, corpus: () => readCorpus(e.artifactsDir, 'data/feeds') };
}

describe('rss-feed formats', () => {
  it('reads RSS 2.0, Atom, RSS 1.0 (RDF) and JSON Feed into one record shape', async () => {
    const w = await world();
    const rdf = 'https://rdf.example.test/index.rdf';
    const jf = 'https://json.example.test/feed.json';
    w.feeds
      .feed(BLOG, {
        format: 'rss',
        title: 'Blog',
        items: [item(1, { categories: ['news', 'tech'] })],
      })
      .feed(NEWS, { format: 'atom', title: 'News', items: [item(2)] })
      .feed(rdf, { format: 'rdf', title: 'Rdf', items: [item(3)] })
      .feed(jf, {
        format: 'json',
        title: 'Json',
        items: [item(4, { contentHtml: '<p>Hello <b>JSON</b></p>' })],
      });
    const r = await w.pass([BLOG, NEWS, rdf, jf]);
    expect(r.error).toBeUndefined();
    expect(r.errors).toBe(0);
    expect(r.written).toBe(4);
    const records = await w.corpus();
    const byFeed = Object.fromEntries(records.map((x) => [x.frontmatter.feed, x]));
    expect(Object.keys(byFeed).sort()).toEqual(['Blog', 'Json', 'News', 'Rdf']);
    for (const rec of records) {
      expect(rec.frontmatter.direction).toBe('inbound');
      expect(rec.frontmatter.author).toBe('Ada');
      expect(rec.frontmatter.date).toMatch(/^2026-10-01T1\d:00:00\.000Z$/);
      expect(rec.path).toMatch(
        /\/2026-10\/\d{3}--2026-10-01T1\d-00--post-number-\d--[0-9a-f]{8}\.md$/,
      );
    }
    expect(byFeed.Blog!.frontmatter.categories).toBe('news, tech');
    expect(byFeed.Blog!.body).toBe('Summary of post 1.');
    expect(byFeed.Json!.body).toBe('Hello **JSON**');
    expect(byFeed.Rdf!.frontmatter.url).toBe('https://blog.example.test/posts/3');
    // Each feed is its own scope directory.
    expect(new Set(records.map((x) => x.path.split('/')[0])).size).toBe(4);
  });

  it('namespaces record identity by feed, so the same guid in two feeds is two records', async () => {
    const w = await world();
    w.feeds
      .feed(BLOG, { format: 'rss', items: [item(1)] })
      .feed(NEWS, { format: 'rss', items: [item(1)] });
    const r = await w.pass([BLOG, NEWS]);
    expect(r.written).toBe(2);
  });

  it('keeps items that fall off the feed (a window, never tombstoned)', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(3), item(2), item(1)] });
    await w.pass([BLOG]);
    w.feeds.trim(BLOG, 1);
    const r = await w.pass([BLOG]);
    expect(r.pruned).toBe(0);
    expect(await w.corpus()).toHaveLength(3);
  });
});

describe('rss-feed conditional GET', () => {
  it('stores ETag and Last-Modified and answers a 304 with a quiet batch', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    await w.pass([BLOG]);
    const second = await w.pass([BLOG]);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(0);
    const [first, again] = w.feeds.requests;
    expect(first!.ifNoneMatch).toBeUndefined();
    expect(again!.ifNoneMatch).toMatch(/^"v\d+-1"$/);
    expect(again!.ifModifiedSince).toBeTruthy();
    expect(again!.status).toBe(304);
    expect(again!.userAgent).toBe(FEED_USER_AGENT);
  });

  it('falls back to If-Modified-Since when the server sends no ETag', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', etag: false, items: [item(1)] });
    await w.pass([BLOG]);
    await w.pass([BLOG]);
    expect(w.feeds.requests[1]!.ifNoneMatch).toBeUndefined();
    expect(w.feeds.requests[1]!.status).toBe(304);
  });

  it('a changed document is re-read in full and only the new item writes', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    await w.pass([BLOG]);
    w.feeds.addItem(BLOG, item(2));
    const r = await w.pass([BLOG]);
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('refreshes an edited item in place', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    await w.pass([BLOG]);
    w.feeds.updateItem(BLOG, 'urn:item:1', { description: 'Corrected text.' });
    const r = await w.pass([BLOG]);
    expect(r.written).toBe(1);
    const records = await w.corpus();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toBe('Corrected text.');
  });
});

describe('rss-feed throttling and paging', () => {
  it('reports 429 and 503 as rateLimited and keeps the cursor', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    await w.pass([BLOG]);
    w.http.failNext({ url: BLOG }, status(503));
    const r = await w.pass([BLOG]);
    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('pages an oversized document with partial batches, then stores the validators', async () => {
    const w = await world();
    w.feeds.feed(BLOG, {
      format: 'rss',
      items: [7, 6, 5, 4, 3, 2, 1].map((n) => item(n)),
    });
    const r = await w.pass([BLOG], {}, 3);
    expect(r.written).toBe(7);
    // Mid-walk rounds re-read unconditionally; the last round stores validators.
    expect(w.feeds.requests.map((x) => x.ifNoneMatch ?? null)).toEqual([null, null, null]);
    const quiet = await w.pass([BLOG], {}, 3);
    expect(quiet.written).toBe(0);
    expect(w.feeds.requests.at(-1)!.status).toBe(304);
  });

  it('keeps only the newest maxItemsPerFeed items', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1), item(3), item(2)] });
    await w.pass([BLOG], { maxItemsPerFeed: 2 });
    const titles = (await w.corpus()).map((x) => x.frontmatter.title).sort();
    expect(titles).toEqual(['Post number 2', 'Post number 3']);
  });
});

describe('rss-feed failures stay per feed', () => {
  it('a malformed feed fails its scope with a clear reason while the others sync', async () => {
    const w = await world();
    const broken = 'https://broken.example.test/rss';
    w.feeds
      .feed(BLOG, { format: 'rss', items: [item(1), item(2)] })
      .raw(broken, '<rss><channel><title>Oops</channel></rss>');
    const r = await w.pass([broken, BLOG]);
    expect(r.error).toBeUndefined();
    expect(r.errors).toBe(1);
    expect(r.written).toBe(2);
    // The failed scope's cursor holds, the healthy one advances.
    const scopes = (r.cursor as { scopes: Record<string, unknown> }).scopes;
    expect(scopes[feedScopeLabel(new URL(broken))]).toBeUndefined();
    expect(scopes[feedScopeLabel(new URL(BLOG))]).toBeTruthy();

    expect(r.failedScopes).toEqual([
      {
        scope: feedScopeLabel(new URL(broken)),
        message: expect.stringMatching(/broken\.example\.test\/rss is not well-formed XML/),
      },
    ]);
  });

  it('with a single feed the reason becomes the pass error', async () => {
    const w = await world();
    w.feeds.raw(BLOG, 'this is not a feed at all', 'text/plain');
    const r = await w.pass([BLOG]);
    expect(r.error).toMatch(/not well-formed XML/);
  });

  it('names HTTP failures, and a 404 hints at the address', async () => {
    const w = await world();
    w.feeds.raw('https://gone.example.test/feed', 'Not here', 'text/plain', { status: 404 });
    const r = await w.pass(['https://gone.example.test/feed']);
    expect(r.error).toMatch(/answered HTTP 404\. Check that the address is still the feed URL\./);
  });

  it('refuses non-http schemes and credentials in the URL, without echoing them', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    const feedsList = [
      'ftp://files.example.test/feed.xml',
      'https://alice:s3cret@blog.example.test/private.xml',
      BLOG,
    ];
    const r = await w.pass(feedsList);
    expect(r.errors).toBe(2);
    expect(r.written).toBe(1);
    expect(w.http.calls.map((c) => c.url.href)).toEqual([BLOG]);
    expect(JSON.stringify(r.scopes)).not.toContain('s3cret');
    expect(JSON.stringify(r.cursor)).not.toContain('s3cret');

    const messages = (r.failedScopes ?? []).map((f) => f.message);
    expect(messages[0]).toMatch(/uses the 'ftp:' scheme/);
    expect(messages[1]).toMatch(/contains a user name or password/);
    expect(messages.join(' ')).not.toContain('s3cret');
    expect(messages.join(' ')).not.toContain('alice');
  });

  it('reads an address pasted without its scheme as https', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1)] });
    const r = await w.pass(['blog.example.test/feed.xml']);
    expect(r.written).toBe(1);
    expect(w.http.calls.map((c) => c.url.href)).toEqual([BLOG]);
  });

  it('fails a binding with no feeds at auth time', async () => {
    const w = await world();
    const r = await w.pass([]);
    expect(r.error).toMatch(/no feed URLs/);
  });
});

describe('rss-feed transport limits', () => {
  it('refuses a document over the size cap, declared or streamed', async () => {
    const w = await world({ maxBytes: 2048 });
    const big = `<rss><channel><title>${'x'.repeat(4096)}</title></channel></rss>`;
    w.feeds.raw(BLOG, big, 'application/rss+xml');
    expect((await w.pass([BLOG])).error).toMatch(/larger than/);
    w.feeds.raw(BLOG, big, 'application/rss+xml', {
      headers: { 'content-length': String(big.length) },
    });
    expect((await w.pass([BLOG])).error).toMatch(/larger than/);
  });

  it('gives up on a feed that does not answer within the timeout', async () => {
    env = await createConnectorTestEnv();
    const hang: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const adapter = new RssFeedAdapter(binding([BLOG]), env.deps({ fetch: hang }), {
      timeoutMs: 50,
    });
    await adapter.ensureAuth();
    const [scope] = await adapter.listScopes();
    await expect(adapter.listChangesSince(scope!, undefined)).rejects.toThrow(
      /did not respond within 1 seconds?\./,
    );
  });

  it('follows redirects, but refuses non-http targets, private hops and long chains', async () => {
    const w = await world();
    const moved = 'https://old.example.test/feed';
    w.feeds.redirect(moved, BLOG, 301).feed(BLOG, { format: 'rss', items: [item(1)] });
    const ok = await w.pass([moved]);
    expect(ok.written).toBe(1);
    // Relative links resolve against where the document was finally served.
    expect(w.feeds.requests.map((r) => r.status)).toEqual([301, 200]);

    const sneaky = 'https://sneaky.example.test/feed';
    w.feeds.redirect(sneaky, 'file:///etc/passwd', 302);
    expect((await w.pass([sneaky])).error).toMatch(/points to a 'file:' address/);

    w.feeds.redirect(sneaky, 'http://169.254.169.254/latest/meta-data/', 302);
    expect((await w.pass([sneaky])).error).toMatch(/private or loopback address/);

    w.feeds.redirect(sneaky, 'https://bob:pw@elsewhere.example.test/feed', 302);
    expect((await w.pass([sneaky])).error).toMatch(/carrying credentials/);

    const loop = 'https://loop.example.test/a';
    w.feeds.redirect(loop, loop, 302);
    expect((await w.pass([loop])).error).toMatch(/redirected more than 5 times/);
  });

  it('allows a private feed the person configured themselves', async () => {
    const w = await world();
    const lan = 'http://192.168.1.20:8080/feed.xml';
    w.feeds.feed(lan, { format: 'rss', items: [item(1)] });
    expect((await w.pass([lan])).written).toBe(1);
  });

  it('never fetches enclosures', async () => {
    const w = await world();
    w.feeds.feed(BLOG, {
      format: 'rss',
      items: [
        item(1, {
          enclosure: {
            url: 'https://cdn.example.test/ep1.mp3',
            type: 'audio/mpeg',
            length: 31_337_000,
          },
        }),
      ],
    });
    await w.pass([BLOG]);
    const [rec] = await w.corpus();
    expect(rec!.frontmatter).toMatchObject({
      enclosure_url: 'https://cdn.example.test/ep1.mp3',
      enclosure_type: 'audio/mpeg',
      enclosure_length: '31337000',
    });
    expect(w.http.calls.every((c) => !c.url.href.includes('cdn.example.test'))).toBe(true);
  });
});

describe('rss-feed autodiscovery', () => {
  it('follows a web page to the feed it advertises, once, and remembers it', async () => {
    const w = await world();
    const page = 'https://www.example.test/';
    w.feeds
      .raw(
        page,
        `<!doctype html><html><head><title>Site</title>
         <link rel="alternate" type="application/rss+xml" title="Comments" href="/feed.xml">
         <link rel="alternate" type="application/atom+xml" href="/comments.xml">
         </head><body>hi</body></html>`,
        'text/html; charset=utf-8',
      )
      .feed('https://www.example.test/feed.xml', { format: 'rss', items: [item(1)] });
    const first = await w.pass([page]);
    expect(first.written).toBe(1);
    const second = await w.pass([page]);
    expect(second.written).toBe(0);
    expect(w.feeds.requests.map((r) => [r.url, r.status])).toEqual([
      [page, 200],
      ['https://www.example.test/feed.xml', 200],
      ['https://www.example.test/feed.xml', 304],
    ]);
  });

  it('a page that names no feed fails with a hint', async () => {
    const w = await world();
    w.feeds.raw(
      'https://www.example.test/',
      '<html><head></head><body>no</body></html>',
      'text/html',
    );
    expect((await w.pass(['https://www.example.test/'])).error).toMatch(
      /names no RSS, Atom or JSON feed/,
    );
  });
});

describe('rss-feed parsing hazards', () => {
  it('does not expand DTD entities (XXE, billion laughs) and fetches nothing extra', async () => {
    const w = await world();
    const doc = `<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY remote SYSTEM "https://evil.example.test/dtd">
  <!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<rss version="2.0"><channel><title>Probe &lol3;</title>
<item><guid>x1</guid><title>Secret: &xxe; &remote;</title><description>&lol3;</description>
<pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    w.feeds.raw(BLOG, doc, 'application/rss+xml');
    const started = Date.now();
    const r = await w.pass([BLOG]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.errors).toBe(0);
    const [rec] = await w.corpus();
    expect(rec!.frontmatter.title).toBe('Secret: &xxe; &remote;');
    expect(rec!.body.length).toBeLessThan(100);
    expect(w.http.calls.map((c) => c.url.href)).toEqual([BLOG]);
  });

  it('tolerates undeclared namespace prefixes and HTML entities', () => {
    const parsed = parseFeedDocument(
      `<rss><channel><title>Caf&eacute; &amp; Co</title><item><title>It&rsquo;s&nbsp;here</title>
       <guid>a</guid><media:thumbnail url="https://img.example.test/a.jpg"/>
       <content:encoded><![CDATA[<p>Body</p>]]></content:encoded></item></channel></rss>`,
      { docUrl: BLOG },
    );
    expect(parsed.title).toBe('Café & Co');
    expect(parsed.items[0]).toMatchObject({
      title: 'It’s here',
      thumbnail: 'https://img.example.test/a.jpg',
      contentHtml: '<p>Body</p>',
    });
  });

  it('resolves relative links against xml:base and the document URL', async () => {
    const parsed = parseFeedDocument(
      `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://site.example.test/blog/">
        <title>Base</title>
        <entry xml:base="2026/"><id>tag:1</id><title>One</title><link href="one.html"/>
          <updated>2026-10-02T00:00:00Z</updated>
          <content type="html">&lt;a href="../about"&gt;about&lt;/a&gt; &lt;img src="pic.png"&gt; &lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;</content>
        </entry></feed>`,
      { docUrl: 'https://feeds.example.test/atom' },
    );
    const entry = parsed.items[0]!;
    expect(entry.link).toBe('https://site.example.test/blog/2026/one.html');
    expect(entry.contentHtml).toContain('href="https://site.example.test/blog/about"');
    expect(entry.contentHtml).toContain('src="https://site.example.test/blog/2026/pic.png"');
    expect(entry.contentHtml).not.toContain('javascript:');

    const rss = parseFeedDocument(
      `<rss><channel><title>R</title><item><title>Rel</title><link>/posts/9</link>
       <description>&lt;p&gt;See &lt;a href="/x"&gt;x&lt;/a&gt;&lt;/p&gt;</description></item></channel></rss>`,
      { docUrl: 'https://blog.example.test/feeds/main.xml' },
    );
    expect(rss.items[0]!.link).toBe('https://blog.example.test/posts/9');
    expect(rss.items[0]!.contentHtml).toContain('href="https://blog.example.test/x"');
  });

  it('decodes a declared legacy charset', () => {
    const latin = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Smörgås</title></channel></rss>',
      'latin1',
    );
    expect(decodeFeedBytes(latin)).toContain('Smörgås');
    expect(decodeFeedBytes(latin, 'text/xml; charset=windows-1252')).toContain('Smörgås');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<rss/>')]);
    expect(decodeFeedBytes(bom, 'text/xml; charset=iso-8859-1')).toBe('<rss/>');
  });

  it('reads feed dates without guessing the machine time zone', () => {
    expect(parseFeedDate('Tue, 10 Jun 2003 04:00:00 GMT')).toBe('2003-06-10T04:00:00.000Z');
    expect(parseFeedDate('Tue, 10 Jun 2003 04:00:00 -0700')).toBe('2003-06-10T11:00:00.000Z');
    expect(parseFeedDate('Sun, 18 Oct 2026 08:00:00 CEST')).toBe('2026-10-18T06:00:00.000Z');
    expect(parseFeedDate('2026-10-18 08:00:00')).toBe('2026-10-18T08:00:00.000Z');
    expect(parseFeedDate('2026-10-18T08:00:00+02:00')).toBe('2026-10-18T06:00:00.000Z');
    expect(parseFeedDate('Someday soon')).toBeUndefined();
    expect(parseFeedDate('')).toBeUndefined();
  });

  it('files undated items under undated/ and still gives them a stable identity', async () => {
    const w = await world();
    w.feeds.feed(BLOG, {
      format: 'rss',
      items: [{ guid: '', title: 'No date, no guid', description: 'x' } as FakeFeedItem],
    });
    // The fake always writes a guid element; an empty one means "no guid".
    await w.pass([BLOG]);
    await w.pass([BLOG]);
    const records = await w.corpus();
    expect(records).toHaveLength(1);
    expect(records[0]!.path).toMatch(/\/undated\/001--undated--no-date-no-guid--/);
    expect(records[0]!.frontmatter.date).toBeUndefined();
  });
});

describe('rss-feed scope naming', () => {
  it('keeps long and query-string feeds in distinct directories', () => {
    const a = feedScopeLabel(
      new URL('https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa'),
    );
    const b = feedScopeLabel(
      new URL('https://www.youtube.com/feeds/videos.xml?channel_id=UCbbbbbbbbbbbbbbbbbbbbbb'),
    );
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(feedScopeLabel(new URL('https://www.example.test/blog/feed/'))).toBe(
      'example.test/blog/feed',
    );
  });

  it('masks secret-looking query values in what records and scopes show', () => {
    const url = new URL('https://pod.example.test/rss?auth=abc123&show=7');
    expect(displayFeedUrl(url)).toBe('https://pod.example.test/rss?auth=REDACTED&show=7');
    expect(feedScopeLabel(url)).not.toContain('abc123');
  });
});

describe('rss-feed records', () => {
  it('writes the frontmatter contract for a podcast episode', async () => {
    const w = await world();
    const pod = 'https://pod.example.test/rss?token=very-secret';
    w.feeds.feed(pod, {
      format: 'rss',
      title: 'The Pod',
      items: [
        item(1, {
          categories: ['Science'],
          enclosure: { url: 'https://cdn.example.test/1.mp3', type: 'audio/mpeg', length: 1000 },
          thumbnail: 'https://cdn.example.test/1.jpg',
        }),
      ],
    });
    await w.pass([pod]);
    const [rec] = await w.corpus();
    expect(Object.keys(rec!.frontmatter)).toEqual([
      'title',
      'date',
      'author',
      'url',
      'feed',
      'feed_url',
      'categories',
      'enclosure_url',
      'enclosure_type',
      'enclosure_length',
      'thumbnail',
      'direction',
      'trust',
      'scan_action',
    ]);
    expect(rec!.frontmatter.feed_url).toBe('https://pod.example.test/rss?token=REDACTED');
    expect(JSON.stringify(rec)).not.toContain('very-secret');
  });

  it('carries the parsed item through RecordRef.raw (no second fetch per record)', async () => {
    const w = await world();
    w.feeds.feed(BLOG, { format: 'rss', items: [item(1), item(2)] });
    const adapter = w.adapter([BLOG]);
    await adapter.ensureAuth();
    const [scope] = await adapter.listScopes();
    const batch = await adapter.listChangesSince(scope!, undefined, { limit: 10 });
    expect(batch.records.map((r: RecordRef) => r.ordinalKey)).toEqual([
      Date.parse(item(2).date!),
      Date.parse(item(1).date!),
    ]);
    const calls = w.http.calls.length;
    await adapter.fetchRecord(scope!, batch.records[0]!);
    expect(w.http.calls.length).toBe(calls);
  });
});
