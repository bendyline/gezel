import type {
  ListPhotosRequest,
  ListPhotosResponse,
  OnThisDayResponse,
  PhotoGroup,
  PhotoGroupsRequest,
  PhotoGroupsResponse,
  PhotoRecord,
} from '@bendyline/gezel';
import type { PhotoRow } from './index-store-types.js';

/**
 * The photo library, read from the index: no file is opened and no model
 * runs. Everything here is a pure function of the pivoted photo rows
 * (`IndexStore.photoRows`), so the tools, the morning card and the tests read
 * one shape.
 */

/** A gap this long between two photos starts a new event. */
const EVENT_GAP_MS = 3 * 60 * 60_000;
/** An event smaller than this is a moment, not an outing. */
const MIN_EVENT_SIZE = 3;
/** Photos an event lists as its sample. */
const EVENT_SAMPLE = 6;
/** Cosine at which two photos count as lookalikes (bursts, retakes). */
const SIMILAR_THRESHOLD = 0.93;
/** The newest photos the lookalike pass compares; it is all-pairs. */
const SIMILAR_MAX_PHOTOS = 1500;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_NEAR_KM = 5;

export interface PhotoQueryContext {
  rows: PhotoRow[];
  /** Whether this caller may see coordinates (the person's app, an on-device session). */
  includeLocation: boolean;
  caption?: (hash: string) => string | null;
}

function toRecord(row: PhotoRow, ctx: PhotoQueryContext): PhotoRecord {
  const camera = [row.camera_make, row.camera_model]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .replace(/^(\S+) \1\b/i, '$1');
  const caption = row.hash ? ctx.caption?.(row.hash) : null;
  const loc = location(row);
  return {
    path: row.path,
    ...(row.taken_at ? { takenAt: row.taken_at } : {}),
    ...(camera ? { camera } : {}),
    ...(row.lens ? { lens: row.lens } : {}),
    ...(row.width ? { width: Number(row.width) } : {}),
    ...(row.height ? { height: Number(row.height) } : {}),
    ...(row.format ? { format: row.format } : {}),
    ...(row.screenshot === '1' ? { screenshot: true } : {}),
    ...(row.cloud_only === '1' ? { cloudOnly: true } : {}),
    ...(caption ? { caption } : {}),
    ...(ctx.includeLocation && loc ? { location: loc } : {}),
  };
}

function location(row: PhotoRow): { lat: number; lon: number } | null {
  if (row.gps_lat === null || row.gps_lon === null) return null;
  const lat = Number(row.gps_lat);
  const lon = Number(row.gps_lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** A capture time, else the file's date, as a sortable `YYYY-MM-DDTHH:MM:SS`. */
function when(row: PhotoRow): string | null {
  if (row.taken_at) return row.taken_at;
  if (row.mtime_ms == null) return null;
  return new Date(row.mtime_ms).toISOString().slice(0, 19);
}

/**
 * `2024`, `2024-06` or `2024-06-01` as an inclusive upper bound on a `when`
 * string: a prefix covers its whole year, month or day.
 */
function upperBound(value: string): string {
  return `${value}\uffff`;
}

export function kmBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function listPhotos(ctx: PhotoQueryContext, req: ListPhotosRequest): ListPhotosResponse {
  const camera = req.camera?.trim().toLowerCase();
  const matched = ctx.rows.filter((row) => {
    const at = when(row);
    if (req.from && (!at || at < req.from)) return false;
    if (req.to && (!at || at > upperBound(req.to))) return false;
    if (
      camera &&
      !`${row.camera_make ?? ''} ${row.camera_model ?? ''}`.toLowerCase().includes(camera)
    ) {
      return false;
    }
    if (req.screenshots === true && row.screenshot !== '1') return false;
    if (req.screenshots === false && row.screenshot === '1') return false;
    if (req.near) {
      // A place filter is itself location: answer it only where locations may be seen.
      if (!ctx.includeLocation) return false;
      const loc = location(row);
      if (!loc || kmBetween(loc, req.near) > (req.near.km ?? DEFAULT_NEAR_KM)) return false;
    }
    return true;
  });
  const limit = req.limit ?? DEFAULT_LIST_LIMIT;
  const withheld = !ctx.includeLocation && ctx.rows.some((r) => location(r) !== null);
  return {
    photos: matched.slice(0, limit).map((row) => toRecord(row, ctx)),
    total: matched.length,
    truncated: matched.length > limit,
    ...(withheld ? { locationWithheld: true } : {}),
  };
}

export function photoGroups(
  ctx: PhotoQueryContext,
  req: PhotoGroupsRequest,
  vectors?: () => Array<{ filePath: string; vec: Float32Array }>,
): PhotoGroupsResponse {
  const limit = req.limit ?? 50;
  const withheld = !ctx.includeLocation && ctx.rows.some((r) => location(r) !== null);
  const flags = withheld ? { locationWithheld: true } : {};
  if (req.by === 'duplicate') {
    const byHash = new Map<string, PhotoRow[]>();
    for (const row of ctx.rows) {
      if (!row.hash) continue;
      const list = byHash.get(row.hash) ?? [];
      list.push(row);
      byHash.set(row.hash, list);
    }
    const groups: PhotoGroup[] = [...byHash.values()]
      .filter((list) => list.length > 1)
      .map((list) => ({
        count: list.length,
        paths: list.map((r) => r.path).sort(),
        bytes: (list.length - 1) * (list[0]!.size ?? 0),
      }))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    return {
      by: 'duplicate',
      groups: groups.slice(0, limit),
      truncated: groups.length > limit,
      engine: 'metadata',
      ...flags,
    };
  }
  if (req.by === 'event') {
    const dated = ctx.rows
      .filter((r) => r.taken_at && r.screenshot !== '1')
      .sort((a, b) => (a.taken_at! < b.taken_at! ? -1 : 1));
    const events: PhotoRow[][] = [];
    let current: PhotoRow[] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const row of dated) {
      const t = Date.parse(`${row.taken_at!}Z`);
      if (current.length > 0 && t - last > EVENT_GAP_MS) {
        events.push(current);
        current = [];
      }
      current.push(row);
      last = t;
    }
    if (current.length > 0) events.push(current);
    const groups: PhotoGroup[] = events
      .filter((e) => e.length >= MIN_EVENT_SIZE)
      .reverse()
      .map((e) => {
        const located = e
          .map(location)
          .filter((l): l is { lat: number; lon: number } => l !== null);
        const centre =
          ctx.includeLocation && located.length > 0
            ? {
                lat: located.reduce((n, l) => n + l.lat, 0) / located.length,
                lon: located.reduce((n, l) => n + l.lon, 0) / located.length,
              }
            : null;
        return {
          from: e[0]!.taken_at!,
          to: e[e.length - 1]!.taken_at!,
          count: e.length,
          paths: spread(e, EVENT_SAMPLE).map((r) => r.path),
          ...(centre ? { location: centre } : {}),
        };
      });
    return {
      by: 'event',
      groups: groups.slice(0, limit),
      truncated: groups.length > limit,
      engine: 'metadata',
      ...flags,
    };
  }
  const all = vectors?.() ?? [];
  if (all.length < 2)
    return { by: 'similar', groups: [], truncated: false, engine: 'unavailable', ...flags };
  const order = new Map(ctx.rows.map((r, i) => [r.path, i]));
  const pool = all
    .filter((v) => order.has(v.filePath) && v.vec.length === all[0]!.vec.length)
    .sort((a, b) => order.get(a.filePath)! - order.get(b.filePath)!)
    .slice(0, SIMILAR_MAX_PHOTOS);
  const parent = pool.map((_, i) => i);
  const find = (start: number): number => {
    let i = start;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (dot(pool[i]!.vec, pool[j]!.vec) >= SIMILAR_THRESHOLD) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, string[]>();
  pool.forEach((v, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), v.filePath]);
  });
  const groups: PhotoGroup[] = [...clusters.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => ({ count: paths.length, paths }))
    .sort((a, b) => b.count - a.count);
  return {
    by: 'similar',
    groups: groups.slice(0, limit),
    truncated: groups.length > limit,
    engine: 'vector',
    ...flags,
  };
}

/** Photos taken on `monthDay` (`MM-DD`) in years before `currentYear`, newest year first. */
export function onThisDay(
  rows: PhotoRow[],
  monthDay: string,
  currentYear: number,
): OnThisDayResponse {
  const byYear = new Map<number, string[]>();
  for (const row of rows) {
    if (!row.taken_at || row.screenshot === '1' || row.taken_at.slice(5, 10) !== monthDay) continue;
    const year = Number(row.taken_at.slice(0, 4));
    if (!Number.isFinite(year) || year >= currentYear) continue;
    byYear.set(year, [...(byYear.get(year) ?? []), row.path]);
  }
  return {
    day: monthDay,
    years: [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, paths]) => ({ year, count: paths.length, paths: paths.slice(0, EVENT_SAMPLE) })),
  };
}

/** `n` items spread across a list: a sample that shows the whole event, not its first minutes. */
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]!);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
