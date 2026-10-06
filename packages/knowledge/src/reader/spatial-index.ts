/**
 * Read-only document point index. The router's ordinary SQLite latitude and
 * longitude indexes provide conservative candidates; the portable gezk
 * spherical predicate decides membership before ranking or pagination.
 * The explicit Qualla adapter keeps already-published 0.6 regional archives
 * useful without interpreting arbitrary producer metadata as coordinates.
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
  locationInBounds,
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
  private legacy: DocumentLocationRow[] | undefined;
  constructor(
    private readonly db: DatabaseSync,
    private readonly allowLegacy: boolean,
  ) {
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
  private legacyRows(): DocumentLocationRow[] {
    if (this.legacy) return this.legacy;
    this.legacy = [];
    if (!this.allowLegacy) return this.legacy;
    for (const row of this.db
      .prepare(
        "SELECT id, meta_json FROM documents WHERE id LIKE 'qualla-%' AND meta_json IS NOT NULL",
      )
      .all()) {
      try {
        const meta = JSON.parse(String(row.meta_json));
        if (
          typeof meta.region !== 'string' ||
          !Array.isArray(meta.quallaArticleIds) ||
          !meta.coordinates
        )
          continue;
        const point = KnowledgeLocationSchema.safeParse({
          id: 'qualla-coordinate',
          role: 'subject',
          latitude: meta.coordinates.lat,
          longitude: meta.coordinates.lng,
          provenance: { adapter: 'qualla-regional-meta@1', articleIds: meta.quallaArticleIds },
        });
        if (point.success)
          this.legacy.push({
            documentId: String(row.id),
            location: { ...point.data, longitude: normalizeLongitude(point.data.longitude) },
          });
      } catch {
        /* Invalid opaque metadata has no usable location. */
      }
    }
    return this.legacy;
  }
  rows(): DocumentLocationRow[] {
    return this.hasTable
      ? this.db
          .prepare('SELECT * FROM document_locations ORDER BY document_id, location_id')
          .all()
          .map((row) => this.decode(row))
      : this.legacyRows();
  }
  locations(documentId: string): KnowledgeLocation[] {
    return this.hasTable
      ? this.db
          .prepare('SELECT * FROM document_locations WHERE document_id = ? ORDER BY location_id')
          .all(documentId)
          .map((row) => this.decode(row).location)
      : this.legacyRows()
          .filter((row) => row.documentId === documentId)
          .map((row) => row.location);
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
    const boxes = radiusBounds(radius);
    const candidates = this.hasTable
      ? boxes.flatMap((box) =>
          this.db
            .prepare(`SELECT * FROM document_locations
          WHERE role = 'subject' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`)
            .all(box.south, box.north, box.west, box.east)
            .map((row) => this.decode(row)),
        )
      : this.legacyRows().filter(
          (row) =>
            row.location.role === 'subject' &&
            boxes.some((box) => locationInBounds(row.location, box)),
        );
    const matches = new Map<string, SpatialMatch>();
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
