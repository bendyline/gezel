import type { PhotoGroupsResponse, ProjectIndexOverview } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type PhotoReportDeps, writeNightlyPhotoReport } from './photo-report.js';

const overview = (images: number): ProjectIndexOverview => ({
  files: images,
  totalBytes: 0,
  byModality: { image: images },
  screenshots: 0,
  cloudOnly: 0,
  duplicates: { groups: 0, extraCopies: 0, bytes: 0 },
});

function deps(opts: {
  images: number;
  events?: PhotoGroupsResponse['groups'];
  duplicates?: PhotoGroupsResponse['groups'];
  years?: Array<{ year: number; count: number; paths: string[] }>;
}) {
  const written = new Map<string, string>();
  const d: PhotoReportDeps = {
    store: {
      readProjectArtifact: async (_id, path) => written.get(path) ?? null,
      writeProjectArtifact: async (_id, path, content) => {
        written.set(path, content);
      },
    },
    contentIndex: {
      overview: async () => overview(opts.images),
      photoGroups: async (_id, req) => ({
        by: req.by,
        groups: (req.by === 'event' ? opts.events : opts.duplicates) ?? [],
        truncated: false,
        engine: 'metadata',
      }),
      onThisDay: async () => ({ day: '10-08', years: opts.years ?? [] }),
    },
  };
  return { d, written };
}

const NOW = new Date(2026, 9, 8, 4, 0);

describe('writeNightlyPhotoReport', () => {
  it('names recent outings, this day in earlier years, and duplicates, once a day', async () => {
    const { d, written } = deps({
      images: 400,
      events: [
        {
          from: '2026-09-20T10:00:00',
          to: '2026-09-20T17:00:00',
          count: 42,
          paths: ['a.jpg', 'b.jpg'],
        },
        { from: '2025-03-01T10:00:00', to: '2025-03-01T12:00:00', count: 12, paths: ['old.jpg'] },
      ],
      duplicates: [
        { count: 3, paths: ['x.jpg', 'x copy.jpg', 'x copy 2.jpg'], bytes: 6 * 1_048_576 },
      ],
      years: [{ year: 2023, count: 8, paths: ['2023/canal.jpg'] }],
    });

    expect(await writeNightlyPhotoReport(d, 'pics', NOW)).toBe('reports/photos-2026-10-08.md');
    const body = written.get('reports/photos-2026-10-08.md')!;
    expect(body).toContain('**2026-09-20** · 42 photos');
    expect(body).not.toContain('old.jpg');
    expect(body).toContain('**2023** · 8 photos');
    expect(body).toContain('2 photos are byte-for-byte copies of another, taking 6 MB');
    expect(body).toContain('Nothing has been moved or deleted.');

    expect(await writeNightlyPhotoReport(d, 'pics', NOW)).toBeNull();
  });

  it('writes nothing for a folder that is not a photo library, or a night with nothing to say', async () => {
    expect(await writeNightlyPhotoReport(deps({ images: 5 }).d, 'docs', NOW)).toBeNull();
    expect(await writeNightlyPhotoReport(deps({ images: 400 }).d, 'pics', NOW)).toBeNull();
  });
});
