import { describe, expect, it } from 'vitest';
import { videoMetricsRecord, videoToRecord } from './youtube-videos.js';

/**
 * Golden normalize tests: `videos.list` resources shaped exactly as the Data
 * API v3 returns them for `part=snippet,contentDetails,statistics,status`, in
 * → exact NormalizedRecord out. A renamed or reshaped field is otherwise
 * invisible until corpora silently lose it.
 */

const UPLOAD = {
  kind: 'youtube#video',
  etag: 'kM2s5aM1y3kq8vBqfT0bS2_9VxU',
  id: 'Xk3fPq9LmN0',
  snippet: {
    publishedAt: '2026-10-11T15:00:06Z',
    channelId: 'UCq7nB5Wd3Bh3H3l2o0bDqGw',
    title: 'Sharpening a hand plane: back, bevel, and the micro-bevel',
    description:
      'Flattening the back, then the bevel.\n\n00:00 Intro\n02:10 Flattening the back\n\nTools: 1000/6000 stone, honing guide.\nhttps://workshopbench.example.com/plane',
    thumbnails: {
      default: { url: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/default.jpg', width: 120, height: 90 },
      medium: { url: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/mqdefault.jpg', width: 320, height: 180 },
      high: { url: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/hqdefault.jpg', width: 480, height: 360 },
      standard: {
        url: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/sddefault.jpg',
        width: 640,
        height: 480,
      },
      maxres: {
        url: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/maxresdefault.jpg',
        width: 1280,
        height: 720,
      },
    },
    channelTitle: 'Workshop Bench',
    tags: ['woodworking', 'hand tools', 'sharpening'],
    categoryId: '26',
    liveBroadcastContent: 'none',
    defaultLanguage: 'en',
    localized: {
      title: 'Sharpening a hand plane: back, bevel, and the micro-bevel',
      description: 'Flattening the back, then the bevel.',
    },
    defaultAudioLanguage: 'en-US',
  },
  contentDetails: {
    duration: 'PT1H2M5S',
    dimension: '2d',
    definition: 'hd',
    caption: 'true',
    licensedContent: true,
    contentRating: {},
    projection: 'rectangular',
  },
  statistics: {
    viewCount: '10234',
    likeCount: '812',
    favoriteCount: '0',
    commentCount: '97',
  },
  status: {
    uploadStatus: 'processed',
    privacyStatus: 'public',
    license: 'youtube',
    embeddable: true,
    publicStatsViewable: true,
    madeForKids: false,
  },
};

const UPCOMING_STREAM = {
  kind: 'youtube#video',
  etag: 'b1',
  id: 'Lv9StReAm00',
  snippet: {
    publishedAt: '2026-10-18T09:00:00Z',
    channelId: 'UCq7nB5Wd3Bh3H3l2o0bDqGw',
    title: 'Live: Q&A from the bench',
    description: '',
    thumbnails: {
      default: {
        url: 'https://i.ytimg.com/vi/Lv9StReAm00/default_live.jpg',
        width: 120,
        height: 90,
      },
      high: {
        url: 'https://i.ytimg.com/vi/Lv9StReAm00/hqdefault_live.jpg',
        width: 480,
        height: 360,
      },
    },
    channelTitle: 'Workshop Bench',
    categoryId: '26',
    liveBroadcastContent: 'upcoming',
    localized: { title: 'Live: Q&A from the bench', description: '' },
  },
  contentDetails: {
    duration: 'P0D',
    dimension: '2d',
    definition: 'sd',
    caption: 'false',
    licensedContent: false,
    contentRating: {},
    projection: 'rectangular',
  },
  // Hidden likes and disabled comments: the keys are simply absent.
  statistics: { viewCount: '0', favoriteCount: '0' },
  status: {
    uploadStatus: 'uploaded',
    privacyStatus: 'unlisted',
    license: 'youtube',
    embeddable: true,
    publicStatsViewable: true,
    madeForKids: false,
  },
};

describe('youtube-videos golden normalization', () => {
  it('normalizes a full upload: duration, tags, captions, best thumbnail, counts', () => {
    const record = videoToRecord(UPLOAD, { metricsUpdatedAt: '2026-10-19T06:00:00.000Z' });
    expect(record).toEqual({
      recordId: 'yt:Xk3fPq9LmN0',
      dirSegments: ['2026-10'],
      fileStem: '2026-10-11T15-00--sharpening-a-hand-plane-back-bevel',
      frontmatter: {
        title: 'Sharpening a hand plane: back, bevel, and the micro-bevel',
        date: '2026-10-11T15:00:06Z',
        platform: 'youtube',
        channel: 'Workshop Bench',
        channel_id: 'UCq7nB5Wd3Bh3H3l2o0bDqGw',
        video_id: 'Xk3fPq9LmN0',
        url: 'https://www.youtube.com/watch?v=Xk3fPq9LmN0',
        duration: '1:02:05',
        duration_iso: 'PT1H2M5S',
        tags: 'woodworking, hand tools, sharpening',
        language: 'en-US',
        privacy: 'public',
        has_captions: 'true',
        thumbnail: 'https://i.ytimg.com/vi/Xk3fPq9LmN0/maxresdefault.jpg',
        views: '10234',
        likes: '812',
        comments: '97',
        metrics_updated_at: '2026-10-19T06:00:00.000Z',
        direction: 'inbound',
      },
      bodyMarkdown:
        'Flattening the back, then the bevel.\n\n00:00 Intro\n02:10 Flattening the back\n\nTools: 1000/6000 stone, honing guide.\nhttps://workshopbench.example.com/plane',
      volatileKeys: ['metrics_updated_at'],
      scanOrigin: 'youtube-videos',
      quarantineNamespace: 'youtube-videos',
      quarantineLabel: 'YouTube video from Workshop Bench',
    });
    // The rendered file keeps insertion order; pin it.
    expect(Object.keys(record.frontmatter)).toEqual([
      'title',
      'date',
      'platform',
      'channel',
      'channel_id',
      'video_id',
      'url',
      'duration',
      'duration_iso',
      'tags',
      'language',
      'privacy',
      'has_captions',
      'thumbnail',
      'views',
      'likes',
      'comments',
      'metrics_updated_at',
      'direction',
    ]);
  });

  it('normalizes an upcoming, unlisted stream with hidden counts and no description', () => {
    const record = videoToRecord(UPCOMING_STREAM, {
      metricsUpdatedAt: '2026-10-19T06:00:00.000Z',
    });
    expect(record.frontmatter).toEqual({
      title: 'Live: Q&A from the bench',
      date: '2026-10-18T09:00:00Z',
      platform: 'youtube',
      channel: 'Workshop Bench',
      channel_id: 'UCq7nB5Wd3Bh3H3l2o0bDqGw',
      video_id: 'Lv9StReAm00',
      url: 'https://www.youtube.com/watch?v=Lv9StReAm00',
      privacy: 'unlisted',
      live: 'upcoming',
      thumbnail: 'https://i.ytimg.com/vi/Lv9StReAm00/hqdefault_live.jpg',
      views: '0',
      metrics_updated_at: '2026-10-19T06:00:00.000Z',
      direction: 'inbound',
    });
    expect(record.bodyMarkdown).toBe('Link: https://www.youtube.com/watch?v=Lv9StReAm00');
    expect(record.fileStem).toBe('2026-10-18T09-00--live-q-a-from-the-bench');
  });

  it('normalizes the day’s engagement reading into the shared metrics-history shape', () => {
    const record = videoMetricsRecord(UPLOAD, '2026-10-19T06:00:00.000Z');
    expect(record.recordId).toBe('metrics:Xk3fPq9LmN0:2026-10-19');
    expect(record.dirSegments).toEqual(['metrics-history', '2026-10']);
    expect(record.fileStem).toBe('2026-10-19--metrics--xk3fpq9lmn0');
    expect(record.frontmatter).toMatchObject({
      title: 'Engagement on 2026-10-19: Sharpening a hand plane: back, bevel, and the micro-bevel',
      date: '2026-10-19T06:00:00.000Z',
      platform: 'youtube',
      post_id: 'Xk3fPq9LmN0',
      permalink: 'https://www.youtube.com/watch?v=Xk3fPq9LmN0',
      views: '10234',
      likes: '812',
      comments: '97',
    });
    expect(record.bodyMarkdown).toBe(
      'Engagement reading for https://www.youtube.com/watch?v=Xk3fPq9LmN0 on 2026-10-19: views 10234, likes 812, comments 97.',
    );
  });
});
