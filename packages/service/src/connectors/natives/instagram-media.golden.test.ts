import { describe, expect, it } from 'vitest';
import { mediaToRecord, profileToStatsRecord } from './instagram-media.js';

/**
 * Golden normalize tests: realistic graph.instagram.com JSON in (including
 * Meta's `+0000` timestamp format), exact NormalizedRecord out. A Graph field
 * renamed under us is otherwise invisible until corpora silently lose data.
 */

const IMAGE_MEDIA = {
  id: '17895695668004550',
  caption: 'New workshop tour!\nCome see where the gezels are carved.',
  media_type: 'IMAGE',
  media_url: 'https://scontent.cdninstagram.com/v/t51.29350-15/workshop.jpg',
  permalink: 'https://www.instagram.com/p/DM1abCdEfGh/',
  timestamp: '2026-08-10T09:30:12+0000',
  like_count: 87,
  comments_count: 6,
};

const CAPTIONLESS_REEL = {
  id: '17900011122233344',
  media_type: 'VIDEO',
  media_url: 'https://scontent.cdninstagram.com/v/t50.2886-16/reel.mp4',
  thumbnail_url: 'https://scontent.cdninstagram.com/v/t51.29350-15/reel-thumb.jpg',
  permalink: 'https://www.instagram.com/reel/DMxYzAbCd12/',
  timestamp: '2026-08-11T18:00:00+0000',
  like_count: 0,
  comments_count: 0,
};

const PROFILE = {
  id: '17841400000000000',
  username: 'gezelworkshop',
  followers_count: 2456,
  follows_count: 180,
  media_count: 74,
};

describe('instagram-media golden normalization', () => {
  it('normalizes an image post with caption, counts, and permalink body link', () => {
    const record = mediaToRecord(IMAGE_MEDIA, { metricsUpdatedAt: '2026-08-12T06:00:00.000Z' });

    expect(record).toEqual({
      recordId: '17895695668004550',
      dirSegments: ['2026-08'],
      fileStem: '2026-08-10T09-30--new-workshop-tour-come-see-where',
      frontmatter: {
        title: 'New workshop tour!',
        date: '2026-08-10T09:30:12+0000',
        platform: 'instagram',
        media_id: '17895695668004550',
        media_type: 'IMAGE',
        permalink: 'https://www.instagram.com/p/DM1abCdEfGh/',
        likes: '87',
        comments: '6',
        has_media: 'true',
        metrics_updated_at: '2026-08-12T06:00:00.000Z',
      },
      bodyMarkdown:
        'New workshop tour!\nCome see where the gezels are carved.\n\n' +
        'https://www.instagram.com/p/DM1abCdEfGh/',
      scanOrigin: 'instagram-media',
      quarantineNamespace: 'instagram-media',
      quarantineLabel: 'Instagram post 17895695668004550',
    });

    // The rendered file preserves insertion order; pin it so a refactor
    // cannot silently reshuffle the corpus.
    expect(Object.keys(record.frontmatter)).toEqual([
      'title',
      'date',
      'platform',
      'media_id',
      'media_type',
      'permalink',
      'likes',
      'comments',
      'has_media',
      'metrics_updated_at',
    ]);
  });

  it('falls back to the media type for a captionless reel', () => {
    const record = mediaToRecord(CAPTIONLESS_REEL, {
      metricsUpdatedAt: '2026-08-12T06:00:00.000Z',
    });

    expect(record.recordId).toBe('17900011122233344');
    expect(record.fileStem).toBe('2026-08-11T18-00--video');
    expect(record.frontmatter.title).toBe('VIDEO');
    expect(record.frontmatter.media_type).toBe('VIDEO');
    expect(record.frontmatter.likes).toBe('0');
    expect(record.frontmatter.comments).toBe('0');
    expect(record.bodyMarkdown).toBe('https://www.instagram.com/reel/DMxYzAbCd12/');
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
        platform: 'instagram',
        author: 'gezelworkshop',
        followers: '2456',
        following: '180',
        posts_count: '74',
      },
      bodyMarkdown: 'Followers: 2456\nFollowing: 180\nPosts: 74',
      scanOrigin: 'instagram-media',
      quarantineNamespace: 'instagram-media',
      quarantineLabel: 'Instagram account stats for @gezelworkshop',
    });
  });
});
