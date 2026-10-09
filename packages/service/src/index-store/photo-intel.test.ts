import { describe, expect, it } from 'vitest';
import type { PhotoRow } from './index-store-types.js';
import { kmBetween, listPhotos, onThisDay, photoGroups } from './photo-intel.js';

function row(path: string, over: Partial<PhotoRow> = {}): PhotoRow {
  return {
    path,
    hash: path,
    size: 1000,
    mtime_ms: Date.parse('2026-01-01T00:00:00Z'),
    taken_at: null,
    camera_make: null,
    camera_model: null,
    lens: null,
    gps_lat: null,
    gps_lon: null,
    width: null,
    height: null,
    format: 'jpeg',
    screenshot: null,
    cloud_only: null,
    ...over,
  };
}

const AMSTERDAM = { gps_lat: '52.373100', gps_lon: '4.892200' };
const PARIS = { gps_lat: '48.856600', gps_lon: '2.352200' };

// Newest first, as IndexStore.photoRows orders them.
const rows: PhotoRow[] = [
  row('2024/beach-3.jpg', {
    taken_at: '2024-07-14T16:40:00',
    camera_make: 'Apple',
    camera_model: 'iPhone 15 Pro',
    ...PARIS,
  }),
  row('2024/beach-2.jpg', {
    taken_at: '2024-07-14T15:10:00',
    camera_make: 'Apple',
    camera_model: 'iPhone 15 Pro',
    ...PARIS,
  }),
  row('2024/beach-1.jpg', {
    taken_at: '2024-07-14T14:00:00',
    camera_make: 'Apple',
    camera_model: 'iPhone 15 Pro',
    ...PARIS,
  }),
  row('2023/canal-3.jpg', {
    taken_at: '2023-10-08T10:20:00',
    camera_make: 'FUJIFILM',
    camera_model: 'X-T5',
    ...AMSTERDAM,
  }),
  row('2023/canal-2.jpg', {
    taken_at: '2023-10-08T10:05:00',
    camera_make: 'FUJIFILM',
    camera_model: 'X-T5',
    ...AMSTERDAM,
  }),
  row('2023/canal-1.jpg', {
    taken_at: '2023-10-08T09:50:00',
    camera_make: 'FUJIFILM',
    camera_model: 'X-T5',
    ...AMSTERDAM,
  }),
  row('2019/birthday.jpg', { taken_at: '2019-10-08T19:00:00' }),
  row('Screenshot 2024-07-14.png', {
    taken_at: '2024-07-14T09:00:00',
    screenshot: '1',
    format: 'png',
  }),
  row('copy/canal-1.jpg', { hash: '2023/canal-1.jpg', taken_at: null }),
];

describe('listPhotos', () => {
  it('filters by date prefix and camera, newest first, with locations for the person', () => {
    const res = listPhotos(
      { rows, includeLocation: true },
      { from: '2023', to: '2023-10', camera: 'fuji' },
    );
    expect(res.photos.map((p) => p.path)).toEqual([
      '2023/canal-3.jpg',
      '2023/canal-2.jpg',
      '2023/canal-1.jpg',
    ]);
    expect(res.photos[0]).toMatchObject({ camera: 'FUJIFILM X-T5', location: { lat: 52.3731 } });
  });

  it('withholds locations, and place searches, from a cloud session', () => {
    const res = listPhotos({ rows, includeLocation: false }, { camera: 'iphone' });
    expect(res.photos).toHaveLength(3);
    expect(res.photos[0]?.location).toBeUndefined();
    expect(res.locationWithheld).toBe(true);
    const near = listPhotos({ rows, includeLocation: false }, { near: { lat: 52.37, lon: 4.89 } });
    expect(near.total).toBe(0);
    expect(
      listPhotos({ rows, includeLocation: true }, { near: { lat: 52.37, lon: 4.89 } }).total,
    ).toBe(3);
  });

  it('keeps or drops screenshots on request', () => {
    expect(listPhotos({ rows, includeLocation: true }, { screenshots: true }).total).toBe(1);
    expect(listPhotos({ rows, includeLocation: true }, { screenshots: false }).total).toBe(8);
  });
});

describe('photoGroups', () => {
  it('splits events at three-hour gaps, newest first, leaving screenshots out', () => {
    const res = photoGroups({ rows, includeLocation: true }, { by: 'event' });
    expect(res.groups.map((g) => [g.from, g.count])).toEqual([
      ['2024-07-14T14:00:00', 3],
      ['2023-10-08T09:50:00', 3],
    ]);
    expect(res.groups[1]?.location?.lat).toBeCloseTo(52.3731, 3);
    expect(
      photoGroups({ rows, includeLocation: false }, { by: 'event' }).groups[0]?.location,
    ).toBeUndefined();
  });

  it('finds byte-identical copies and the space they take', () => {
    const res = photoGroups({ rows, includeLocation: true }, { by: 'duplicate' });
    expect(res.groups).toEqual([
      { count: 2, paths: ['2023/canal-1.jpg', 'copy/canal-1.jpg'], bytes: 1000 },
    ]);
  });

  it('groups lookalikes by image vector, and says when there are none', () => {
    const unit = (x: number, y: number) => {
      const n = Math.hypot(x, y);
      return new Float32Array([x / n, y / n]);
    };
    const vectors = [
      { filePath: '2024/beach-1.jpg', vec: unit(1, 0) },
      { filePath: '2024/beach-2.jpg', vec: unit(1, 0.05) },
      { filePath: '2023/canal-1.jpg', vec: unit(0, 1) },
    ];
    const res = photoGroups({ rows, includeLocation: true }, { by: 'similar' }, () => vectors);
    expect(res.engine).toBe('vector');
    expect(res.groups.map((g) => g.paths.sort())).toEqual([
      ['2024/beach-1.jpg', '2024/beach-2.jpg'],
    ]);
    expect(photoGroups({ rows, includeLocation: true }, { by: 'similar' }).engine).toBe(
      'unavailable',
    );
  });
});

describe('onThisDay', () => {
  it('lists earlier years for this calendar day, newest first', () => {
    expect(onThisDay(rows, '10-08', 2026)).toEqual({
      day: '10-08',
      years: [
        {
          year: 2023,
          count: 3,
          paths: ['2023/canal-3.jpg', '2023/canal-2.jpg', '2023/canal-1.jpg'],
        },
        { year: 2019, count: 1, paths: ['2019/birthday.jpg'] },
      ],
    });
  });
});

describe('kmBetween', () => {
  it('measures great-circle distance', () => {
    expect(kmBetween({ lat: 52.3731, lon: 4.8922 }, { lat: 48.8566, lon: 2.3522 })).toBeCloseTo(
      430,
      -1,
    );
  });
});
