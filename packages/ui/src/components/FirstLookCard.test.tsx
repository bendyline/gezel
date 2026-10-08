import type { ProjectIndexOverview } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { firstLookSummary, firstNightEstimate } from './FirstLookCard.js';

const photos: ProjectIndexOverview = {
  files: 13_400,
  totalBytes: 40e9,
  byModality: { image: 12_480, video: 300, doc: 20 },
  screenshots: 840,
  cloudOnly: 1204,
  takenRange: { from: '2009-05-02T10:00:00', to: '2026-09-30T18:00:00' },
  duplicates: { groups: 2900, extraCopies: 3100, bytes: 9e9 },
  modifiedRange: { from: '2009-05-02T10:00:00.000Z', to: '2026-09-30T18:00:00.000Z' },
};

describe('first look', () => {
  it('reads a photo folder by its years, duplicates and screenshots', () => {
    expect(firstLookSummary(photos, 'pictures')).toEqual([
      '12,480 photos from 2009 to 2026',
      'about 3,100 look like duplicates',
      '840 screenshots',
    ]);
  });

  it('reads documents and code by what they are', () => {
    const docs = {
      ...photos,
      byModality: { doc: 400, text: 20 },
      duplicates: { groups: 0, extraCopies: 0, bytes: 0 },
      screenshots: 0,
    };
    expect(firstLookSummary(docs, 'documents')).toEqual(['420 documents']);
    const code = { ...docs, files: 900, byModality: { code: 700, text: 200 } };
    expect(firstLookSummary(code, 'code')).toEqual(['900 files, 700 of them code']);
  });

  it('estimates the first night only when it takes hours, leaving cloud photos out', () => {
    expect(firstNightEstimate(photos)).toBe(
      'Describing 11,276 photos takes about 7 hours on this computer. Your crew picks up where it left off each night.',
    );
    expect(firstNightEstimate({ ...photos, byModality: { image: 200 }, cloudOnly: 0 })).toBeNull();
  });
});
