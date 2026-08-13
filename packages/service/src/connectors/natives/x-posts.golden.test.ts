import { describe, expect, it } from 'vitest';
import { mentionToRecord, profileToStatsRecord, tweetToRecord, xPermalink } from './x-posts.js';

/**
 * Golden normalize tests: realistic X API v2 JSON in, exact NormalizedRecord
 * out. A v2 field renamed under us is otherwise invisible until corpora
 * silently lose data.
 */

const FULL_TWEET = {
  id: '1954312345678901234',
  edit_history_tweet_ids: ['1954312345678901234'],
  text: 'Shipping the X connector today!\nDetails: https://t.co/AbC123xyz',
  created_at: '2026-08-10T09:30:12.000Z',
  lang: 'en',
  entities: {
    urls: [
      {
        start: 41,
        end: 64,
        url: 'https://t.co/AbC123xyz',
        expanded_url: 'https://gezel.example/launch',
        display_url: 'gezel.example/launch',
      },
    ],
  },
  referenced_tweets: [{ type: 'replied_to', id: '1954000000000000001' }],
  attachments: { media_keys: ['3_1954312345678901111'] },
  public_metrics: {
    retweet_count: 7,
    reply_count: 3,
    like_count: 42,
    quote_count: 1,
    bookmark_count: 5,
    impression_count: 1234,
  },
};

const MENTION_TWEET = {
  id: '1954500000000000003',
  edit_history_tweet_ids: ['1954500000000000003'],
  text: 'Have you seen what @gezeldev is building? https://t.co/QqQ111ab',
  created_at: '2026-08-11T14:05:00.000Z',
  lang: 'en',
  author_id: '777001',
  entities: {
    urls: [
      {
        start: 42,
        end: 65,
        url: 'https://t.co/QqQ111ab',
        expanded_url: 'https://example.com/post/connectors',
        display_url: 'example.com/post/connectors',
      },
    ],
  },
};

const PROFILE = {
  id: '9001',
  name: 'Gezel Dev',
  username: 'gezeldev',
  public_metrics: {
    followers_count: 1234,
    following_count: 321,
    tweet_count: 567,
    listed_count: 12,
    like_count: 89,
  },
};

describe('x-posts golden normalization', () => {
  it('normalizes a full tweet with counts, reply threading, media, and expanded links', () => {
    const record = tweetToRecord(FULL_TWEET, {
      username: 'gezeldev',
      metricsUpdatedAt: '2026-08-12T06:00:00.000Z',
    });

    expect(record).toEqual({
      recordId: '1954312345678901234',
      dirSegments: ['2026-08'],
      fileStem: '2026-08-10T09-30--shipping-the-x-connector-today-details',
      frontmatter: {
        title: 'Shipping the X connector today!',
        date: '2026-08-10T09:30:12.000Z',
        platform: 'x',
        author: 'gezeldev',
        tweet_id: '1954312345678901234',
        permalink: 'https://x.com/gezeldev/status/1954312345678901234',
        in_reply_to: '1954000000000000001',
        likes: '42',
        reposts: '7',
        replies: '3',
        quotes: '1',
        bookmarks: '5',
        views: '1234',
        lang: 'en',
        has_media: 'true',
        metrics_updated_at: '2026-08-12T06:00:00.000Z',
      },
      bodyMarkdown: 'Shipping the X connector today!\nDetails: https://gezel.example/launch',
      scanOrigin: 'x-posts',
      quarantineNamespace: 'x-posts',
      quarantineLabel: 'X post by @gezeldev',
    });

    // The rendered file preserves insertion order; pin it so a refactor
    // cannot silently reshuffle the corpus.
    expect(Object.keys(record.frontmatter)).toEqual([
      'title',
      'date',
      'platform',
      'author',
      'tweet_id',
      'permalink',
      'in_reply_to',
      'likes',
      'reposts',
      'replies',
      'quotes',
      'bookmarks',
      'views',
      'lang',
      'has_media',
      'metrics_updated_at',
    ]);
  });

  it('normalizes a bare tweet: zero counts, no media, no reply, no lang', () => {
    const record = tweetToRecord(
      { id: '1954400000000000002', text: 'gm', created_at: '2026-08-11T07:00:00.000Z' },
      { username: 'gezeldev', metricsUpdatedAt: '2026-08-12T06:00:00.000Z' },
    );

    expect(record.recordId).toBe('1954400000000000002');
    expect(record.fileStem).toBe('2026-08-11T07-00--gm');
    expect(record.frontmatter.likes).toBe('0');
    expect(record.frontmatter.reposts).toBe('0');
    expect(record.frontmatter.bookmarks).toBe('0');
    expect(record.frontmatter.views).toBe('0');
    expect(record.frontmatter.has_media).toBe('false');
    expect(record.frontmatter.in_reply_to).toBeUndefined();
    expect(record.frontmatter.lang).toBeUndefined();
    expect(record.bodyMarkdown).toBe('gm');
  });

  it('normalizes a mention with its expanded author', () => {
    const record = mentionToRecord(MENTION_TWEET, { id: '777001', username: 'alice' });

    expect(record).toEqual({
      recordId: '1954500000000000003',
      dirSegments: ['2026-08'],
      fileStem: '2026-08-11T14-05--mention-from-alice',
      frontmatter: {
        title: 'mention from alice',
        date: '2026-08-11T14:05:00.000Z',
        platform: 'x',
        author: 'alice',
        tweet_id: '1954500000000000003',
        permalink: 'https://x.com/alice/status/1954500000000000003',
        lang: 'en',
      },
      bodyMarkdown: 'Have you seen what @gezeldev is building? https://example.com/post/connectors',
      scanOrigin: 'x-posts',
      quarantineNamespace: 'x-posts',
      quarantineLabel: 'X mention from @alice',
    });
  });

  it('falls back to the account-agnostic /i/ permalink when the author expansion is missing', () => {
    const record = mentionToRecord(MENTION_TWEET, undefined);
    expect(record.frontmatter.author).toBe('unknown');
    expect(record.frontmatter.permalink).toBe('https://x.com/i/status/1954500000000000003');
    expect(xPermalink('', '42')).toBe('https://x.com/i/status/42');
  });

  it('normalizes a profile snapshot into the day-keyed stats record', () => {
    const record = profileToStatsRecord(PROFILE, '2026-08-12');

    expect(record).toEqual({
      recordId: 'stats-2026-08-12',
      dirSegments: ['2026-08'],
      fileStem: 'stats-2026-08-12',
      frontmatter: {
        title: 'Account stats 2026-08-12',
        date: '2026-08-12',
        platform: 'x',
        author: 'gezeldev',
        followers: '1234',
        following: '321',
        posts_count: '567',
      },
      bodyMarkdown: 'Followers: 1234\nFollowing: 321\nPosts: 567',
      scanOrigin: 'x-posts',
      quarantineNamespace: 'x-posts',
      quarantineLabel: 'X account stats for @gezeldev',
    });
  });
});
