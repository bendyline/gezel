/**
 * Portable point locations and radius predicates for gezk 0.7. Coordinates
 * are WGS84 degrees; distances use the specified 6,371,000 m sphere. These
 * browser-safe contracts are shared by compilers, readers, and service APIs.
 * Bounds are conservative candidates only: membership always uses distance.
 */
import { z } from 'zod';
import { KnowledgeDocumentIdSchema } from './schemas/ids.js';

export const GEZK_EARTH_RADIUS_METERS = 6_371_000;
export const MAX_DOCUMENT_LOCATIONS = 256;
export const KnowledgeLocationSchema = z
  .object({
    id: KnowledgeDocumentIdSchema,
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    role: z.enum(['subject', 'associated']),
    provenance: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type KnowledgeLocation = z.infer<typeof KnowledgeLocationSchema>;
export const KnowledgeLocationsSchema = z
  .array(KnowledgeLocationSchema)
  .max(MAX_DOCUMENT_LOCATIONS)
  .superRefine((locations, ctx) => {
    const ids = new Set<string>();
    for (const [index, location] of locations.entries()) {
      if (ids.has(location.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'duplicate location id' });
      ids.add(location.id);
    }
  });
export const KnowledgeRadiusSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radiusMeters: z.number().finite().nonnegative(),
  })
  .strict();
export type KnowledgeRadius = z.infer<typeof KnowledgeRadiusSchema>;
export const KnowledgeBoundsSchema = z
  .object({
    west: z.number().finite().min(-180).max(180),
    south: z.number().finite().min(-90).max(90),
    east: z.number().finite().min(-180).max(180),
    north: z.number().finite().min(-90).max(90),
  })
  .strict()
  .refine((b) => b.west <= b.east && b.south <= b.north, 'bounds must not wrap');
export type KnowledgeBounds = z.infer<typeof KnowledgeBoundsSchema>;
export const KnowledgeSpatialManifestSchema = z
  .object({
    schema: z.literal('document-points@1'),
    crs: z.literal('EPSG:4326'),
    distanceModel: z.literal('sphere-6371000'),
    locationCount: z.number().int().nonnegative(),
    locatedDocuments: z.number().int().nonnegative(),
    coverage: z.array(KnowledgeBoundsSchema).max(2),
  })
  .strict()
  .refine((s) => s.locatedDocuments <= s.locationCount, 'located documents exceed locations');
export type KnowledgeSpatialManifest = z.infer<typeof KnowledgeSpatialManifestSchema>;

export function normalizeLongitude(longitude: number): number {
  return longitude === 180 ? -180 : longitude === 0 ? 0 : longitude;
}

export function locationDistanceMeters(
  from: Pick<KnowledgeLocation, 'latitude' | 'longitude'>,
  to: Pick<KnowledgeLocation, 'latitude' | 'longitude'>,
): number {
  if (
    from.latitude === to.latitude &&
    (Math.abs(from.latitude) === 90 ||
      normalizeLongitude(from.longitude) === normalizeLongitude(to.longitude))
  )
    return 0;
  const radians = Math.PI / 180;
  const dlat = (to.latitude - from.latitude) * radians;
  const dlon = (normalizeLongitude(to.longitude) - normalizeLongitude(from.longitude)) * radians;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(dlon / 2) ** 2;
  const clamped = Math.max(0, Math.min(1, a));
  return 2 * GEZK_EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export function radiusBounds(raw: KnowledgeRadius): KnowledgeBounds[] {
  const radius = KnowledgeRadiusSchema.parse(raw);
  if (radius.radiusMeters === 0) {
    const longitude = normalizeLongitude(radius.longitude);
    return [
      {
        west: Math.abs(radius.latitude) === 90 ? -180 : longitude,
        east: Math.abs(radius.latitude) === 90 ? 180 : longitude,
        south: radius.latitude,
        north: radius.latitude,
      },
    ];
  }
  const radians = Math.PI / 180;
  const delta = Math.min(Math.PI, radius.radiusMeters / GEZK_EARTH_RADIUS_METERS);
  const lat = radius.latitude * radians;
  const padding = radius.radiusMeters > 0 ? 1e-10 : 0;
  const south = Math.max(-90, (lat - delta) / radians - padding);
  const north = Math.min(90, (lat + delta) / radians + padding);
  if (south <= -90 || north >= 90) return [{ west: -180, east: 180, south, north }];
  const width = Math.asin(Math.min(1, Math.sin(delta) / Math.cos(lat))) / radians + padding;
  const lon = normalizeLongitude(radius.longitude);
  const west = lon - width;
  const east = lon + width;
  if (west < -180)
    return [
      { west: west + 360, east: 180, south, north },
      { west: -180, east, south, north },
    ];
  if (east >= 180)
    return [
      { west, east: 180, south, north },
      { west: -180, east: east - 360, south, north },
    ];
  return [{ west, east, south, north }];
}

export function locationInBounds(location: KnowledgeLocation, bounds: KnowledgeBounds): boolean {
  const longitude = normalizeLongitude(location.longitude);
  return (
    location.latitude >= bounds.south &&
    location.latitude <= bounds.north &&
    longitude >= bounds.west &&
    longitude <= bounds.east
  );
}

export function spatialManifest(
  locations: Array<{ documentId: string; location: KnowledgeLocation }>,
): KnowledgeSpatialManifest {
  const subjects = locations.filter((r) => r.location.role === 'subject');
  const coverage: KnowledgeBounds[] = [];
  if (subjects.length) {
    const latitudes = subjects.map((r) => r.location.latitude);
    const longitudes = [
      ...new Set(subjects.map((r) => normalizeLongitude(r.location.longitude))),
    ].sort((a, b) => a - b);
    let gap = -1;
    let startIndex = 0;
    for (let i = 0; i < longitudes.length; i++) {
      const next =
        longitudes[(i + 1) % longitudes.length]! + (i === longitudes.length - 1 ? 360 : 0);
      if (next - longitudes[i]! > gap) {
        gap = next - longitudes[i]!;
        startIndex = (i + 1) % longitudes.length;
      }
    }
    let south = 90;
    let north = -90;
    for (const latitude of latitudes) {
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
    const west = longitudes[startIndex]!;
    const east = longitudes[(startIndex + longitudes.length - 1) % longitudes.length]!;
    if (west <= east) coverage.push({ west, east, south, north });
    else coverage.push({ west, east: 180, south, north }, { west: -180, east, south, north });
  }
  return {
    schema: 'document-points@1',
    crs: 'EPSG:4326',
    distanceModel: 'sphere-6371000',
    locationCount: locations.length,
    locatedDocuments: new Set(locations.map((r) => r.documentId)).size,
    coverage,
  };
}
