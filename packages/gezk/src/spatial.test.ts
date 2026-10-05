/** Portable schema and spherical-predicate regression tests. */
import { describe, expect, it } from 'vitest';
import {
  KnowledgeLocationsSchema,
  KnowledgeRadiusSchema,
  locationDistanceMeters,
  radiusBounds,
} from './spatial.js';
describe('location contracts', () => {
  it('rejects invalid coordinates, roles, duplicate ids and non-finite radii', () => {
    const p = { id: 'primary', latitude: 0, longitude: 0, role: 'subject' };
    for (const points of [
      [{ ...p, latitude: 91 }],
      [{ ...p, longitude: -181 }],
      [{ ...p, role: 'mentioned' }],
      [p, p],
    ])
      expect(KnowledgeLocationsSchema.safeParse(points).success).toBe(false);
    expect(
      KnowledgeRadiusSchema.safeParse({
        latitude: 0,
        longitude: 0,
        radiusMeters: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });
  it('normalizes zero-distance antimeridian and pole aliases', () => {
    expect(
      locationDistanceMeters({ latitude: 0, longitude: 180 }, { latitude: 0, longitude: -180 }),
    ).toBe(0);
    expect(
      locationDistanceMeters({ latitude: 90, longitude: 0 }, { latitude: 90, longitude: 180 }),
    ).toBe(0);
    expect(radiusBounds({ latitude: 0, longitude: 179.9, radiusMeters: 50_000 })).toHaveLength(2);
  });
  it('keeps zero-radius decimal bounds exact without a radians round trip', () => {
    expect(radiusBounds({ latitude: 30.1, longitude: 50.2, radiusMeters: 0 })).toEqual([
      { south: 30.1, north: 30.1, west: 50.2, east: 50.2 },
    ]);
  });
});
