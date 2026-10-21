import { describe, expect, it } from 'vitest';
import { type FeedRecordContext, feedItemToRecord, parseFeedDocument } from './rss-feed.js';

/**
 * Golden normalize tests: real-world-shaped feed documents in, exact parsed
 * items and NormalizedRecords out. Each document copies the quirks of a
 * common publisher — WordPress, an Apple-style podcast, a static-site Atom
 * feed with xml:base and XHTML content, YouTube's channel feed, a
 * Slashdot-style RSS 1.0 feed, and a micro.blog-style JSON Feed — so a
 * parser change that drops a field shows up here first.
 */

function ctx(feedUrl: string, feedTitle?: string): FeedRecordContext {
  return { key: feedUrl, feedUrl, ...(feedTitle ? { feedTitle } : {}) };
}

const WORDPRESS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:atom="http://www.w3.org/2005/Atom"
	xmlns:sy="http://purl.org/rss/1.0/modules/syndication/"
	xmlns:slash="http://purl.org/rss/1.0/modules/slash/"
	>

<channel>
	<title>Field Notes</title>
	<atom:link href="https://fieldnotes.example.com/feed/" rel="self" type="application/rss+xml" />
	<link>https://fieldnotes.example.com</link>
	<description>Notes from the field</description>
	<lastBuildDate>Fri, 16 Oct 2026 14:02:11 +0000</lastBuildDate>
	<language>en-US</language>
	<sy:updatePeriod>
	hourly	</sy:updatePeriod>
	<generator>https://wordpress.org/?v=6.8</generator>
	<item>
		<title>Planting garlic in October</title>
		<link>https://fieldnotes.example.com/2026/10/planting-garlic/</link>
		<comments>https://fieldnotes.example.com/2026/10/planting-garlic/#respond</comments>
		<dc:creator><![CDATA[Maria Okafor]]></dc:creator>
		<pubDate>Fri, 16 Oct 2026 13:45:00 +0000</pubDate>
		<category><![CDATA[Garden]]></category>
		<category><![CDATA[Seasonal]]></category>
		<guid isPermaLink="false">https://fieldnotes.example.com/?p=4182</guid>
		<description><![CDATA[Cloves go in six weeks before the ground freezes. [&#8230;]]]></description>
		<content:encoded><![CDATA[<p>Cloves go in <strong>six weeks</strong> before the ground freezes.</p>
<p><img src="/wp-content/uploads/2026/10/garlic.jpg" alt="Garlic bed" /></p>
<p>See <a href="/2025/10/garlic-harvest/">last year&#8217;s harvest</a>.</p>]]></content:encoded>
		<wfw:commentRss>https://fieldnotes.example.com/2026/10/planting-garlic/feed/</wfw:commentRss>
		<slash:comments>3</slash:comments>
	</item>
	</channel>
</rss>
`;

const PODCAST = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Long Table</title>
    <link>https://longtable.example.org</link>
    <language>en</language>
    <itunes:author>Long Table Media</itunes:author>
    <itunes:image href="https://cdn.example.org/cover.jpg"/>
    <itunes:category text="Arts"><itunes:category text="Food"/></itunes:category>
    <item>
      <title>Ep. 42: Bread, Salt &amp; Time</title>
      <description>&lt;p&gt;We talk sourdough with a baker who has kept one starter alive since 1998.&lt;/p&gt;</description>
      <enclosure url="https://cdn.example.org/audio/ep42.mp3" length="48213004" type="audio/mpeg"/>
      <guid isPermaLink="false">longtable-ep-42</guid>
      <pubDate>Tue, 13 Oct 2026 05:00:00 GMT</pubDate>
      <itunes:duration>3015</itunes:duration>
      <itunes:image href="https://cdn.example.org/ep42.jpg"/>
      <itunes:episode>42</itunes:episode>
      <itunes:explicit>false</itunes:explicit>
      <podcast:transcript url="https://cdn.example.org/ep42.vtt" type="text/vtt"/>
    </item>
  </channel>
</rss>
`;

const ATOM_BLOG = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://dev.example.net/">
  <title type="text">Compiler Diary</title>
  <subtitle>Notes on making code fast</subtitle>
  <link href="https://dev.example.net/" rel="alternate" type="text/html"/>
  <link href="https://dev.example.net/atom.xml" rel="self"/>
  <id>https://dev.example.net/</id>
  <updated>2026-10-14T09:00:00+02:00</updated>
  <author><name>Lin Wei</name><uri>https://dev.example.net/about</uri></author>
  <entry>
    <title type="html">Inlining &lt;code&gt;memcpy&lt;/code&gt;</title>
    <link href="posts/inlining-memcpy/" rel="alternate" type="text/html"/>
    <id>tag:dev.example.net,2026-10-12:/posts/inlining-memcpy</id>
    <published>2026-10-12T18:30:00+02:00</published>
    <updated>2026-10-14T09:00:00+02:00</updated>
    <category term="compilers" label="Compilers"/>
    <category term="perf"/>
    <summary type="text">Why the optimizer gave up.</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>The optimizer <em>gave up</em> on <a href="/posts/part-1/">part one</a>.</p></div></content>
  </entry>
</feed>
`;

const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCq7nB5Wd3Bh3H3l2o0bDqGw"/>
 <id>yt:channel:q7nB5Wd3Bh3H3l2o0bDqGw</id>
 <yt:channelId>q7nB5Wd3Bh3H3l2o0bDqGw</yt:channelId>
 <title>Workshop Bench</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCq7nB5Wd3Bh3H3l2o0bDqGw"/>
 <author>
  <name>Workshop Bench</name>
  <uri>https://www.youtube.com/channel/UCq7nB5Wd3Bh3H3l2o0bDqGw</uri>
 </author>
 <published>2019-03-02T10:11:12+00:00</published>
 <entry>
  <id>yt:video:Xk3fPq9LmN0</id>
  <yt:videoId>Xk3fPq9LmN0</yt:videoId>
  <yt:channelId>UCq7nB5Wd3Bh3H3l2o0bDqGw</yt:channelId>
  <title>Sharpening a hand plane</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=Xk3fPq9LmN0"/>
  <author>
   <name>Workshop Bench</name>
   <uri>https://www.youtube.com/channel/UCq7nB5Wd3Bh3H3l2o0bDqGw</uri>
  </author>
  <published>2026-10-11T15:00:06+00:00</published>
  <updated>2026-10-12T02:14:41+00:00</updated>
  <media:group>
   <media:title>Sharpening a hand plane</media:title>
   <media:content url="https://www.youtube.com/v/Xk3fPq9LmN0?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i3.ytimg.com/vi/Xk3fPq9LmN0/hqdefault.jpg" width="480" height="360"/>
   <media:description>Flattening the back, then the bevel.
Tools: 1000/6000 stone.</media:description>
   <media:community>
    <media:starRating count="812" average="5.00" min="1" max="5"/>
    <media:statistics views="10234"/>
   </media:community>
  </media:group>
 </entry>
</feed>
`;

const RDF = `<?xml version="1.0" encoding="ISO-8859-1"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:slash="http://purl.org/rss/1.0/modules/slash/" xmlns:syn="http://purl.org/rss/1.0/modules/syndication/">
<channel rdf:about="https://tech.example.org/">
<title>Tech Example</title>
<link>https://tech.example.org/</link>
<description>News for nerds</description>
<dc:language>en-us</dc:language>
<items>
 <rdf:Seq>
  <rdf:li rdf:resource="https://tech.example.org/story/26/10/15/1234/open-hardware" />
 </rdf:Seq>
</items>
</channel>
<item rdf:about="https://tech.example.org/story/26/10/15/1234/open-hardware">
<title>Open Hardware Router Ships</title>
<link>https://tech.example.org/story/26/10/15/1234/open-hardware?utm_source=rss1.0mainlinkanon</link>
<description>An anonymous reader writes: the first batch shipped this week.&lt;p&gt;&lt;div class="share_submission"&gt;&lt;/div&gt;&lt;/p&gt;</description>
<dc:creator>msmash</dc:creator>
<dc:date>2026-10-15T14:20:00+00:00</dc:date>
<dc:subject>hardware</dc:subject>
<slash:department>long-awaited</slash:department>
<slash:section>news</slash:section>
<slash:comments>48</slash:comments>
</item>
</rdf:RDF>
`;

const JSON_FEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Small Joys',
  home_page_url: 'https://smalljoys.example.com/',
  feed_url: 'https://smalljoys.example.com/feed.json',
  authors: [{ name: 'Priya N.', url: 'https://smalljoys.example.com/about' }],
  language: 'en',
  items: [
    {
      id: 'https://smalljoys.example.com/2026/10/09/1200.html',
      url: 'https://smalljoys.example.com/2026/10/09/1200.html',
      content_html: '<p>First frost on the <a href="/tags/garden">garden</a> this morning.</p>',
      date_published: '2026-10-09T12:00:00-04:00',
      tags: ['garden', 'autumn'],
      image: 'https://smalljoys.example.com/uploads/frost.jpg',
    },
    {
      id: '2026-10-07-note',
      title: 'Reading list',
      content_text: 'Three books for the dark evenings.\n\n1. A long novel.',
      date_published: '2026-10-07T20:15:00Z',
      authors: [{ name: 'Guest Writer' }],
      attachments: [
        {
          url: 'https://smalljoys.example.com/audio/note.m4a',
          mime_type: 'audio/x-m4a',
          size_in_bytes: 2048000,
          duration_in_seconds: 125,
        },
      ],
    },
  ],
});

describe('rss-feed golden normalization', () => {
  it('WordPress RSS 2.0: content:encoded wins, relative links resolve, comments link kept', async () => {
    const feedUrl = 'https://fieldnotes.example.com/feed/';
    const parsed = parseFeedDocument(WORDPRESS, { docUrl: feedUrl });
    expect(parsed.format).toBe('rss');
    expect(parsed.title).toBe('Field Notes');
    expect(parsed.link).toBe('https://fieldnotes.example.com/');
    expect(parsed.items).toHaveLength(1);

    const record = await feedItemToRecord(parsed.items[0]!, ctx(feedUrl, parsed.title));
    expect(record).toEqual({
      recordId: 'https://fieldnotes.example.com/feed/#https://fieldnotes.example.com/?p=4182',
      dirSegments: ['2026-10'],
      fileStem: '2026-10-16T13-45--planting-garlic-in-october',
      frontmatter: {
        title: 'Planting garlic in October',
        date: '2026-10-16T13:45:00.000Z',
        author: 'Maria Okafor',
        url: 'https://fieldnotes.example.com/2026/10/planting-garlic/',
        feed: 'Field Notes',
        feed_url: 'https://fieldnotes.example.com/feed/',
        categories: 'Garden, Seasonal',
        comments_url: 'https://fieldnotes.example.com/2026/10/planting-garlic/#respond',
        direction: 'inbound',
      },
      bodyMarkdown:
        'Cloves go in **six weeks** before the ground freezes.\n\n' +
        '![Garlic bed](https://fieldnotes.example.com/wp-content/uploads/2026/10/garlic.jpg)\n\n' +
        'See [last year’s harvest](https://fieldnotes.example.com/2025/10/garlic-harvest/).',
      scanOrigin: 'rss-feed',
      quarantineNamespace: 'rss-feed',
      quarantineLabel: 'Feed item from Field Notes',
    });
  });

  it('podcast RSS: enclosure recorded (not downloaded), iTunes duration, image and channel author', async () => {
    const feedUrl = 'https://longtable.example.org/feed.rss';
    const parsed = parseFeedDocument(PODCAST, { docUrl: feedUrl });
    expect(parsed.items[0]).toEqual({
      guid: 'longtable-ep-42',
      title: 'Ep. 42: Bread, Salt & Time',
      contentHtml:
        '<p>We talk sourdough with a baker who has kept one starter alive since 1998.</p>',
      published: '2026-10-13T05:00:00.000Z',
      authors: ['Long Table Media'],
      categories: [],
      enclosures: [
        { url: 'https://cdn.example.org/audio/ep42.mp3', type: 'audio/mpeg', length: 48213004 },
      ],
      thumbnail: 'https://cdn.example.org/ep42.jpg',
      duration: '50:15',
    });

    const record = await feedItemToRecord(parsed.items[0]!, ctx(feedUrl, parsed.title));
    expect(record.recordId).toBe('https://longtable.example.org/feed.rss#longtable-ep-42');
    expect(record.fileStem).toBe('2026-10-13T05-00--ep-42-bread-salt-time');
    expect(record.frontmatter).toEqual({
      title: 'Ep. 42: Bread, Salt & Time',
      date: '2026-10-13T05:00:00.000Z',
      author: 'Long Table Media',
      feed: 'The Long Table',
      feed_url: 'https://longtable.example.org/feed.rss',
      enclosure_url: 'https://cdn.example.org/audio/ep42.mp3',
      enclosure_type: 'audio/mpeg',
      enclosure_length: '48213004',
      duration: '50:15',
      thumbnail: 'https://cdn.example.org/ep42.jpg',
      direction: 'inbound',
    });
    expect(record.bodyMarkdown).toBe(
      'We talk sourdough with a baker who has kept one starter alive since 1998.',
    );
  });

  it('Atom with xml:base, an HTML title, XHTML content and a feed-level author', async () => {
    const feedUrl = 'https://dev.example.net/atom.xml';
    const parsed = parseFeedDocument(ATOM_BLOG, { docUrl: feedUrl });
    expect(parsed.format).toBe('atom');
    expect(parsed.title).toBe('Compiler Diary');
    expect(parsed.link).toBe('https://dev.example.net/');
    const entry = parsed.items[0]!;
    expect(entry).toMatchObject({
      guid: 'tag:dev.example.net,2026-10-12:/posts/inlining-memcpy',
      link: 'https://dev.example.net/posts/inlining-memcpy/',
      title: 'Inlining memcpy',
      published: '2026-10-12T16:30:00.000Z',
      updated: '2026-10-14T07:00:00.000Z',
      authors: ['Lin Wei'],
      categories: ['Compilers', 'perf'],
      enclosures: [],
    });

    const record = await feedItemToRecord(entry, ctx(feedUrl, parsed.title));
    expect(record.frontmatter).toEqual({
      title: 'Inlining memcpy',
      date: '2026-10-12T16:30:00.000Z',
      author: 'Lin Wei',
      url: 'https://dev.example.net/posts/inlining-memcpy/',
      feed: 'Compiler Diary',
      feed_url: 'https://dev.example.net/atom.xml',
      categories: 'Compilers, perf',
      direction: 'inbound',
    });
    expect(record.bodyMarkdown).toBe(
      'The optimizer *gave up* on [part one](https://dev.example.net/posts/part-1/).',
    );
    expect(record.dirSegments).toEqual(['2026-10']);
  });

  it("YouTube's channel feed: media:group description and thumbnail, no view counts", async () => {
    const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCq7nB5Wd3Bh3H3l2o0bDqGw';
    const parsed = parseFeedDocument(YOUTUBE, { docUrl: feedUrl });
    const record = await feedItemToRecord(parsed.items[0]!, ctx(feedUrl, parsed.title));
    expect(record).toEqual({
      recordId: `${feedUrl}#yt:video:Xk3fPq9LmN0`,
      dirSegments: ['2026-10'],
      fileStem: '2026-10-11T15-00--sharpening-a-hand-plane',
      frontmatter: {
        title: 'Sharpening a hand plane',
        date: '2026-10-11T15:00:06.000Z',
        author: 'Workshop Bench',
        url: 'https://www.youtube.com/watch?v=Xk3fPq9LmN0',
        feed: 'Workshop Bench',
        feed_url: feedUrl,
        thumbnail: 'https://i3.ytimg.com/vi/Xk3fPq9LmN0/hqdefault.jpg',
        direction: 'inbound',
      },
      bodyMarkdown: 'Flattening the back, then the bevel.\nTools: 1000/6000 stone.',
      scanOrigin: 'rss-feed',
      quarantineNamespace: 'rss-feed',
      quarantineLabel: 'Feed item from Workshop Bench',
    });
  });

  it('RSS 1.0 (RDF): rdf:about identity, Dublin Core date, creator and subject', async () => {
    const feedUrl = 'https://tech.example.org/index.rdf';
    const parsed = parseFeedDocument(RDF, { docUrl: feedUrl });
    expect(parsed.format).toBe('rdf');
    expect(parsed.title).toBe('Tech Example');
    const record = await feedItemToRecord(parsed.items[0]!, ctx(feedUrl, parsed.title));
    expect(record.recordId).toBe(
      'https://tech.example.org/index.rdf#https://tech.example.org/story/26/10/15/1234/open-hardware',
    );
    expect(record.frontmatter).toEqual({
      title: 'Open Hardware Router Ships',
      date: '2026-10-15T14:20:00.000Z',
      author: 'msmash',
      url: 'https://tech.example.org/story/26/10/15/1234/open-hardware?utm_source=rss1.0mainlinkanon',
      feed: 'Tech Example',
      feed_url: 'https://tech.example.org/index.rdf',
      categories: 'hardware',
      direction: 'inbound',
    });
    expect(record.bodyMarkdown).toBe(
      'An anonymous reader writes: the first batch shipped this week.',
    );
  });

  it('JSON Feed 1.1: untitled micro-posts, feed-level authors, tags, attachments', async () => {
    const feedUrl = 'https://smalljoys.example.com/feed.json';
    const parsed = parseFeedDocument(JSON_FEED, {
      docUrl: feedUrl,
      contentType: 'application/feed+json',
    });
    expect(parsed.format).toBe('json');
    expect(parsed.link).toBe('https://smalljoys.example.com/');

    const micro = await feedItemToRecord(parsed.items[0]!, ctx(feedUrl, parsed.title));
    expect(micro.recordId).toBe(
      'https://smalljoys.example.com/feed.json#https://smalljoys.example.com/2026/10/09/1200.html',
    );
    expect(micro.frontmatter).toEqual({
      title: 'First frost on the garden this morning.',
      date: '2026-10-09T16:00:00.000Z',
      author: 'Priya N.',
      url: 'https://smalljoys.example.com/2026/10/09/1200.html',
      feed: 'Small Joys',
      feed_url: feedUrl,
      categories: 'garden, autumn',
      thumbnail: 'https://smalljoys.example.com/uploads/frost.jpg',
      direction: 'inbound',
    });
    expect(micro.bodyMarkdown).toBe(
      'First frost on the [garden](https://smalljoys.example.com/tags/garden) this morning.',
    );

    const note = await feedItemToRecord(parsed.items[1]!, ctx(feedUrl, parsed.title));
    expect(note.recordId).toBe('https://smalljoys.example.com/feed.json#2026-10-07-note');
    expect(note.frontmatter).toEqual({
      title: 'Reading list',
      date: '2026-10-07T20:15:00.000Z',
      author: 'Guest Writer',
      feed: 'Small Joys',
      feed_url: feedUrl,
      enclosure_url: 'https://smalljoys.example.com/audio/note.m4a',
      enclosure_type: 'audio/x-m4a',
      enclosure_length: '2048000',
      duration: '2:05',
      direction: 'inbound',
    });
    expect(note.bodyMarkdown).toBe('Three books for the dark evenings.\n\n1. A long novel.');
  });
});
