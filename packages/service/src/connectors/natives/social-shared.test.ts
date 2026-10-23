import { describe, expect, it } from 'vitest';
import {
  deletedPostRecordIds,
  mergeWatchedPosts,
  metricsHistoryRecord,
  parseWatchedPosts,
  vanishedPosts,
} from './social-shared.js';

describe('deletion watch', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-08-20T12:00:00Z');

  it('merges sightings by id, drops what aged out of the window, and keeps the newest cap', () => {
    const merged = mergeWatchedPosts(
      [
        ['a', now - 2 * DAY],
        ['old', now - 40 * DAY],
      ],
      [
        ['b', now - DAY],
        ['a', now - 2 * DAY],
        ['c', now],
      ],
      now - 30 * DAY,
      2,
    );
    expect(merged).toEqual([
      ['c', now],
      ['b', now - DAY],
    ]);
  });

  it('names only watched posts inside the enumerated span that the walk never met', () => {
    const watch = [['a', now] as const, ['b', now - DAY] as const, ['c', now - 5 * DAY] as const];
    expect(vanishedPosts(watch, new Set(['a']), now - 2 * DAY)).toEqual([['b', now - DAY]]);
    expect(vanishedPosts(watch, new Set(['a', 'b', 'c']), Number.NEGATIVE_INFINITY)).toEqual([]);
    // An empty enumeration is a hiccup until proven otherwise.
    expect(vanishedPosts(watch, new Set(), Number.NEGATIVE_INFINITY)).toEqual([]);
  });

  it('parses a persisted watch defensively', () => {
    expect(parseWatchedPosts([['a', 1], ['b', 'x'], 'junk', [null, 2], ['c', 3, 4]])).toEqual([
      ['a', 1],
    ]);
    expect(parseWatchedPosts(undefined)).toEqual([]);
  });

  it('tombstones the post and one engagement reading per UTC day since it was created', () => {
    expect(
      deletedPostRecordIds(
        '42',
        Date.parse('2026-08-18T23:30:00Z'),
        new Date('2026-08-20T01:00:00Z'),
      ),
    ).toEqual(['42', 'metrics:42:2026-08-18', 'metrics:42:2026-08-19', 'metrics:42:2026-08-20']);
  });
});

const IDENTITY = {
  scanOrigin: 'bluesky-posts',
  quarantineNamespace: 'bluesky-posts',
  quarantineLabel: 'Metrics reading',
};

describe('metricsHistoryRecord', () => {
  it('builds a per (post, day) record under the metrics-history bucket', () => {
    const record = metricsHistoryRecord(
      {
        platform: 'bluesky',
        postId: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
        permalink: 'https://bsky.app/profile/me.bsky.social/post/3kxyz',
        title: 'Launch day!',
        observedAt: '2026-08-12T09:30:00.000Z',
        counts: [
          ['likes', 14],
          ['reposts', 3],
          ['replies', 2],
          ['quotes', undefined],
        ],
      },
      IDENTITY,
    );

    expect(record.recordId).toBe('metrics:at://did:plc:abc/app.bsky.feed.post/3kxyz:2026-08-12');
    expect(record.dirSegments).toEqual(['metrics-history', '2026-08']);
    expect(record.fileStem).toBe('2026-08-12--metrics--3kxyz');
    expect(record.frontmatter).toEqual({
      title: 'Engagement on 2026-08-12: Launch day!',
      date: '2026-08-12T09:30:00.000Z',
      platform: 'bluesky',
      direction: 'inbound',
      post_id: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
      permalink: 'https://bsky.app/profile/me.bsky.social/post/3kxyz',
      url: 'https://bsky.app/profile/me.bsky.social/post/3kxyz',
      likes: '14',
      reposts: '3',
      replies: '2',
    });
    expect(record.bodyMarkdown).toContain('likes 14, reposts 3, replies 2');
    expect(record.scanOrigin).toBe('bluesky-posts');
  });

  it('same post + same day yields a stable recordId (refresh-in-place), new day a new one', () => {
    const base = {
      platform: 'x',
      postId: '1811234567890',
      observedAt: '2026-08-12T06:00:00Z',
      counts: [['likes', 1]] as const,
    };
    const a = metricsHistoryRecord(base, IDENTITY);
    const b = metricsHistoryRecord({ ...base, observedAt: '2026-08-12T22:00:00Z' }, IDENTITY);
    const c = metricsHistoryRecord({ ...base, observedAt: '2026-08-13T06:00:00Z' }, IDENTITY);
    expect(a.recordId).toBe(b.recordId);
    expect(a.recordId).not.toBe(c.recordId);
  });

  it('falls back to the id tail when the post has no title and drops empty counts lines', () => {
    const record = metricsHistoryRecord(
      {
        platform: 'instagram',
        postId: '17900000000000001',
        observedAt: '2026-08-12T12:00:00Z',
        counts: [
          ['likes', undefined],
          ['comments', undefined],
        ],
      },
      IDENTITY,
    );
    expect(record.frontmatter.title).toBe('Engagement on 2026-08-12: 17900000000000001');
    expect(record.frontmatter.likes).toBeUndefined();
    expect(record.bodyMarkdown).toBe('Engagement reading for 17900000000000001 on 2026-08-12.');
  });
});
