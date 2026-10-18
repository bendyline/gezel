/**
 * Read-only document point index. The router's ordinary SQLite latitude and
 * longitude indexes provide conservative candidates; the portable gezk
 * spherical predicate decides membership before ranking or pagination.
 * Archives without a `document_locations` table (before 0.7) have no
 * locations: opaque producer metadata is never read as coordinates.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  type KnowledgeLocation,
  KnowledgeLocationSchema,
  KnowledgeLocationsSchema,
  type KnowledgeRadius,
  KnowledgeRadiusSchema,
  type KnowledgeSpatialManifest,
  locationDistanceMeters,
  normalizeLongitude,
  radiusBounds,
  spatialManifest,
} from '@bendyline/gezk';

export interface SpatialMatch {
  distanceMeters: number;
  matchedLocation: KnowledgeLocation;
}
export interface DocumentLocationRow {
  documentId: string;
  location: KnowledgeLocation;
}

export class DocumentSpatialIndex {
  readonly hasTable: boolean;
  constructor(private readonly db: DatabaseSync) {
    this.hasTable = Boolean(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_locations'")
        .get(),
    );
  }
  private decode(row: Record<string, unknown>): DocumentLocationRow {
    const provenance = row.provenance_json;
    if (typeof provenance === 'string' && Buffer.byteLength(provenance) > 16_384)
      throw new Error('location provenance exceeds 16384 bytes');
    return {
      documentId: String(row.document_id),
      location: KnowledgeLocationSchema.parse({
        id: row.location_id,
        latitude: row.latitude,
        longitude: row.longitude,
        role: row.role,
        ...(provenance === null ? {} : { provenance: JSON.parse(String(provenance)) }),
      }),
    };
  }
  rows(): DocumentLocationRow[] {
    if (!this.hasTable) return [];
    return this.db
      .prepare('SELECT * FROM document_locations ORDER BY document_id, location_id')
      .all()
      .map((row) => this.decode(row));
  }
  locations(documentId: string): KnowledgeLocation[] {
    if (!this.hasTable) return [];
    return this.db
      .prepare('SELECT * FROM document_locations WHERE document_id = ? ORDER BY location_id')
      .all(documentId)
      .map((row) => this.decode(row).location);
  }
  integrity(): { hasTable: boolean; manifest: KnowledgeSpatialManifest } {
    const rows = this.rows();
    const grouped = new Map<string, KnowledgeLocation[]>();
    for (const row of rows) {
      if (normalizeLongitude(row.location.longitude) !== row.location.longitude)
        throw new Error('location longitude must be in [-180, 180)');
      const points = grouped.get(row.documentId) ?? [];
      points.push(row.location);
      grouped.set(row.documentId, points);
      if (!this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(row.documentId))
        throw new Error('location references missing document');
    }
    for (const points of grouped.values()) KnowledgeLocationsSchema.parse(points);
    return { hasTable: this.hasTable, manifest: spatialManifest(rows) };
  }
  matches(raw: KnowledgeRadius): Map<string, SpatialMatch> {
    const radius = KnowledgeRadiusSchema.parse(raw);
    const matches = new Map<string, SpatialMatch>();
    if (!this.hasTable) return matches;
    const candidates = radiusBounds(radius).flatMap((box) =>
      this.db
        .prepare(`SELECT * FROM document_locations
          WHERE role = 'subject' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`)
        .all(box.south, box.north, box.west, box.east)
        .map((row) => this.decode(row)),
    );
    for (const { documentId, location } of candidates) {
      const distanceMeters = locationDistanceMeters(radius, location);
      if (distanceMeters > radius.radiusMeters) continue;
      const previous = matches.get(documentId);
      if (
        !previous ||
        distanceMeters < previous.distanceMeters ||
        (distanceMeters === previous.distanceMeters && location.id < previous.matchedLocation.id)
      ) {
        matches.set(documentId, { distanceMeters, matchedLocation: location });
      }
    }
    return matches;
  }
}
