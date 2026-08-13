import { describe, expect, it } from 'vitest';
import {
  blueskyPermalink,
  notificationToRecord,
  postToRecord,
  profileToStatsRecord,
} from './bluesky-posts.js';

/**
 * Golden normalize tests: realistic AT Protocol JSON in, exact
 * NormalizedRecord out. A Bluesky lexicon field renamed under us is
 * otherwise invisible until corpora silently lose data.
 */

const ACCOUNT_DID = 'did:plc:ab12cd34ef56gh78ij90kl12';

const FEED_VIEW_POST = {
  post: {
    uri: `at://${ACCOUNT_DID}/app.bsky.feed.post/3kwx2eppdmk2h`,
    cid: 'bafyreid27zk7ihvp3czxlqk2hm3dcvnwjfeavci5t4v2y2yggbnzonyaue',
    author: {
      did: ACCOUNT_DID,
      handle: 'gezel.bsky.social',
      displayName: 'Gezel',
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: 'Shipping the new connector today!\nDetails in the thread below.',
      createdAt: '2026-08-10T09:30:12.345Z',
      langs: ['en', 'nl'],
      reply: {
        root: {
          uri: 'at://did:plc:rootauthor/app.bsky.feed.post/3kroot111',
          cid: 'bafyroot',
        },
        parent: {
          uri: 'at://did:plc:parentauthor/app.bsky.feed.post/3kparent22',
          cid: 'bafyparent',
        },
      },
    },
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: [
        {
          thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/one@jpeg',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/one@jpeg',
          alt: 'Screenshot of the connector settings page',
          aspectRatio: { width: 1600, height: 900 },
        },
        {
          thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/two@jpeg',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/two@jpeg',
          alt: '',
        },
      ],
    },
    replyCount: 3,
    repostCount: 7,
    likeCount: 42,
    quoteCount: 1,
    indexedAt: '2026-08-10T09:30:13.000Z',
  },
};

const MENTION_NOTIFICATION = {
  uri: 'at://did:plc:friend123abc/app.bsky.feed.post/3kmention1',
  cid: 'bafymention',
  author: {
    did: 'did:plc:friend123abc',
    handle: 'alice.bsky.social',
    displayName: 'Alice',
  },
  reason: 'mention',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'Have you seen what @gezel.bsky.social is building?',
    createdAt: '2026-08-11T14:05:00.000Z',
  },
  isRead: false,
  indexedAt: '2026-08-11T14:05:01.000Z',
};

const PROFILE = {
  did: ACCOUNT_DID,
  handle: 'gezel.bsky.social',
  displayName: 'Gezel',
  description: 'A team of craftsmen.',
  followersCount: 1234,
  followsCount: 321,
  postsCount: 567,
  indexedAt: '2026-08-12T00:00:00.000Z',
};

describe('bluesky-posts golden normalization', () => {
  it('normalizes a feed view post with counts, image embeds, and reply threading', () => {
    const record = postToRecord(FEED_VIEW_POST, {
      accountHandle: 'gezel.bsky.social',
      metricsUpdatedAt: '2026-08-12T06:00:00.000Z',
    });

    expect(record).toEqual({
      recordId: `at://${ACCOUNT_DID}/app.bsky.feed.post/3kwx2eppdmk2h`,
      dirSegments: ['2026-08'],
      fileStem: '2026-08-10T09-30--shipping-the-new-connector-today-details',
      frontmatter: {
        title: 'Shipping the new connector today!',
        date: '2026-08-10T09:30:12.345Z',
        platform: 'bluesky',
        author: 'gezel.bsky.social',
        uri: `at://${ACCOUNT_DID}/app.bsky.feed.post/3kwx2eppdmk2h`,
        permalink: 'https://bsky.app/profile/gezel.bsky.social/post/3kwx2eppdmk2h',
        in_reply_to: 'at://did:plc:parentauthor/app.bsky.feed.post/3kparent22',
        likes: '42',
        reposts: '7',
        replies: '3',
        quotes: '1',
        lang: 'en',
        has_media: 'true',
        metrics_updated_at: '2026-08-12T06:00:00.000Z',
      },
      bodyMarkdown:
        'Shipping the new connector today!\nDetails in the thread below.\n\n' +
        'Image: Screenshot of the connector settings page',
      scanOrigin: 'bluesky-posts',
      quarantineNamespace: 'bluesky-posts',
      quarantineLabel: 'Bluesky post by @gezel.bsky.social',
    });

    // The rendered file preserves insertion order; pin it so a refactor
    // cannot silently reshuffle the corpus.
    expect(Object.keys(record.frontmatter)).toEqual([
      'title',
      'date',
      'platform',
      'author',
      'uri',
      'permalink',
      'in_reply_to',
      'likes',
      'reposts',
      'replies',
      'quotes',
      'lang',
      'has_media',
      'metrics_updated_at',
    ]);
  });

  it('normalizes an external-link post without media and derives the permalink from the at-uri rkey', () => {
    const record = postToRecord(
      {
        post: {
          uri: `at://${ACCOUNT_DID}/app.bsky.feed.post/3labcdefgh12`,
          cid: 'bafylink',
          author: { did: ACCOUNT_DID, handle: 'gezel.bsky.social' },
          record: {
            $type: 'app.bsky.feed.post',
            text: 'Worth a read.',
            createdAt: '2026-08-09T18:00:00.000Z',
          },
          embed: {
            $type: 'app.bsky.embed.external#view',
            external: {
              uri: 'https://example.com/post/connectors',
              title: 'Connectors, explained',
              description: 'How local-first connectors keep your data yours.',
            },
          },
          likeCount: 0,
          indexedAt: '2026-08-09T18:00:01.000Z',
        },
      },
      { accountHandle: 'gezel.bsky.social', metricsUpdatedAt: '2026-08-12T06:00:00.000Z' },
    );

    expect(blueskyPermalink('gezel.bsky.social', record.recordId)).toBe(
      'https://bsky.app/profile/gezel.bsky.social/post/3labcdefgh12',
    );
    expect(record.frontmatter.permalink).toBe(
      'https://bsky.app/profile/gezel.bsky.social/post/3labcdefgh12',
    );
    expect(record.frontmatter.has_media).toBe('false');
    expect(record.frontmatter.likes).toBe('0');
    expect(record.frontmatter.in_reply_to).toBeUndefined();
    expect(record.frontmatter.lang).toBeUndefined();
    expect(record.bodyMarkdown).toBe(
      'Worth a read.\n\n' +
        'Link: Connectors, explained\n' +
        'How local-first connectors keep your data yours.\n' +
        'https://example.com/post/connectors',
    );
  });

  it('normalizes a mention notification', () => {
    const record = notificationToRecord(MENTION_NOTIFICATION);

    expect(record).toEqual({
      recordId: 'at://did:plc:friend123abc/app.bsky.feed.post/3kmention1',
      dirSegments: ['2026-08'],
      fileStem: '2026-08-11T14-05--mention-from-alice-bsky-social',
      frontmatter: {
        title: 'mention from alice.bsky.social',
        date: '2026-08-11T14:05:00.000Z',
        platform: 'bluesky',
        reason: 'mention',
        author: 'alice.bsky.social',
        uri: 'at://did:plc:friend123abc/app.bsky.feed.post/3kmention1',
        permalink: 'https://bsky.app/profile/alice.bsky.social/post/3kmention1',
      },
      bodyMarkdown: 'Have you seen what @gezel.bsky.social is building?',
      scanOrigin: 'bluesky-posts',
      quarantineNamespace: 'bluesky-posts',
      quarantineLabel: 'Bluesky mention from @alice.bsky.social',
    });
  });

  it('normalizes a profile snapshot into the day-keyed stats record', () => {
    const record = profileToStatsRecord(PROFILE, '2026-08-12', 'gezel.bsky.social');

    expect(record).toEqual({
      recordId: 'stats-2026-08-12',
      dirSegments: ['2026-08'],
      fileStem: 'stats-2026-08-12',
      frontmatter: {
        title: 'Account stats 2026-08-12',
        date: '2026-08-12',
        platform: 'bluesky',
        author: 'gezel.bsky.social',
        followers: '1234',
        following: '321',
        posts_count: '567',
      },
      bodyMarkdown: 'Followers: 1234\nFollowing: 321\nPosts: 567',
      scanOrigin: 'bluesky-posts',
      quarantineNamespace: 'bluesky-posts',
      quarantineLabel: 'Bluesky account stats for @gezel.bsky.social',
    });
  });
});
