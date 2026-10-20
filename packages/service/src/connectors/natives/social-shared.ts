/**
 * Platform-agnostic helpers for the social-posts native adapters (Bluesky, X,
 * Instagram): the shared corpus shape (month buckets, iso-minute stems,
 * ordered frontmatter), the engagement-history record, and the deletion watch.
 * Nothing in this file may know a platform SDK or a platform record shape.
 */

import type { NormalizedRecord } from '../types.js';
import { slug } from '../writer.js';

/**
 * True when a periodic window refresh is due. A missing or unparseable
 * `lastIso` counts as due, so a fresh binding refreshes on its first pass.
 */
export function windowRefreshDue(lastIso: string | undefined, hours: number, now: Date): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 3_600_000;
}

/**
 * First line of a post's text as a display title, ellipsized past `max`
 * chars. Empty when the text has no first line — callers choose the platform
 * fallback ('(no text)', the media type, …).
 */
export function firstLineTitle(text: string, max = 80): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return '';
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
}

/** Month-bucket (`YYYY-MM`) dirSegments for a record timestamp. */
export function monthSegments(iso: string | undefined): string[] {
  const month = (iso ?? '').slice(0, 7);
  return [/^\d{4}-\d{2}$/.test(month) ? month : 'undated'];
}

/**
 * `<iso-minute>--<slug of the first ~6 words>` file stem — mail's iso-minute
 * convention (colons become dashes so the stem stays a safe path segment).
 */
export function postFileStem(iso: string | undefined, text: string): string {
  const isoMin = (iso ?? '').slice(0, 16).replace(/:/g, '-') || 'undated';
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
  return `${isoMin}--${slug(words || 'post', 48)}`;
}

/**
 * Ordered frontmatter assembly. The rendered record keeps insertion order, so
 * callers list keys exactly once in their canonical order; empty/undefined
 * values are dropped rather than serialized as blanks.
 */
export function orderedFrontmatter(
  pairs: ReadonlyArray<readonly [key: string, value: string | number | boolean | undefined]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value === undefined || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

export interface MetricsObservation {
  platform: string;
  /** The platform-native post id (at:// URI, tweet id, media id). */
  postId: string;
  permalink?: string;
  /** Display title of the observed post (its first line, usually). */
  title?: string;
  /** ISO timestamp of the pass that took this reading. */
  observedAt: string;
  /** Ordered engagement counts (likes, reposts, replies, views, …). */
  counts: ReadonlyArray<readonly [key: string, value: number | undefined]>;
}

/**
 * One append-only engagement observation: `metrics:<postId>:<day>` — a per
 * (post, local-day) record under the posts scope's `metrics-history/` bucket.
 * Same-day re-observations refresh the day's record in place (stable
 * recordId → the writer's content-hash refresh); a new day appends a new
 * record. Flat days still write a row — an engagement curve needs its
 * flatline points — and volume stays bounded by the adapter's metrics
 * window (only re-walked posts are observed). Never prune-eligible: social
 * corpora are `window` completeness, and history is the point.
 */
export function metricsHistoryRecord(
  obs: MetricsObservation,
  identity: { scanOrigin: string; quarantineNamespace: string; quarantineLabel: string },
): NormalizedRecord {
  const day = obs.observedAt.slice(0, 10);
  const idTail = obs.postId.split('/').at(-1) ?? obs.postId;
  const countsLine = obs.counts
    .filter((pair): pair is readonly [string, number] => typeof pair[1] === 'number')
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
  return {
    recordId: metricsHistoryRecordId(obs.postId, day),
    dirSegments: ['metrics-history', ...monthSegments(day)],
    fileStem: `${day}--metrics--${slug(idTail, 32)}`,
    frontmatter: orderedFrontmatter([
      ['title', `Engagement on ${day}: ${obs.title || idTail}`],
      ['date', obs.observedAt],
      ['platform', obs.platform],
      ['direction', 'inbound'],
      ['post_id', obs.postId],
      ['permalink', obs.permalink],
      ['url', obs.permalink],
      ...obs.counts,
    ]),
    bodyMarkdown: countsLine
      ? `Engagement reading for ${obs.permalink ?? obs.postId} on ${day}: ${countsLine}.`
      : `Engagement reading for ${obs.permalink ?? obs.postId} on ${day}.`,
    scanOrigin: identity.scanOrigin,
    quarantineNamespace: identity.quarantineNamespace,
    quarantineLabel: identity.quarantineLabel,
  };
}

/** The recordId of one (post, UTC day) engagement reading. */
export function metricsHistoryRecordId(postId: string, day: string): string {
  return `metrics:${postId}:${day}`;
}

// ── deletion watch ─────────────────────────────────────────────────────────
//
// None of the three platforms reports a deleted post in the feeds these
// adapters read: the post simply stops being returned. A walk that enumerates
// a time span completely can tell "deleted" from "never seen" only if it
// remembers which posts lived in that span, so each posts cursor carries a
// small watch of `[post id, sort ms]` pairs for the newest posts inside the
// metrics window. The metrics re-walk already enumerates that window, so the
// check costs no extra reads; deletions of posts older than the window, or
// beyond the watch cap, are not detected.

/** Watched posts per scope cursor; bounds the cursor (it lives in project.json). */
export const DELETION_WATCH_CAP = 100;

/** `[stable post id, ms of the post on the feed's sort axis]`. */
export type WatchedPost = readonly [id: string, ms: number];

/** Read a persisted watch, dropping anything malformed. */
export function parseWatchedPosts(raw: unknown): WatchedPost[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchedPost[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, ms] = entry as unknown[];
    if (typeof id === 'string' && id && typeof ms === 'number' && Number.isFinite(ms)) {
      out.push([id, ms]);
    }
  }
  return out;
}

/**
 * Fold newly seen posts into a watch: one entry per id (the newest sighting
 * wins), nothing older than the window floor, the newest `cap` kept.
 */
export function mergeWatchedPosts(
  prior: readonly WatchedPost[],
  seen: readonly WatchedPost[],
  floorMs: number,
  cap = DELETION_WATCH_CAP,
): WatchedPost[] {
  const byId = new Map<string, number>();
  for (const [id, ms] of [...prior, ...seen]) byId.set(id, ms);
  return [...byId]
    .filter(([, ms]) => ms >= floorMs)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap);
}

/**
 * Watched posts a walk should have returned but did not. `fromMs` is the
 * oldest instant the walk enumerated completely (inclusive); a post at or
 * after it that the walk never saw is gone upstream. A walk that saw nothing
 * at all proves nothing — an API hiccup answering with an empty page must not
 * empty the corpus — so it names no deletions.
 */
export function vanishedPosts(
  watch: readonly WatchedPost[],
  seenIds: ReadonlySet<string>,
  fromMs: number,
): WatchedPost[] {
  if (seenIds.size === 0) return [];
  return watch.filter(([id, ms]) => ms >= fromMs && !seenIds.has(id));
}

/**
 * Every recordId a deleted post may have left behind in the posts scope: the
 * post itself and one engagement reading per UTC day from its creation day
 * through today. Ids the corpus never held are ignored by the engine's sweep,
 * so enumerating days that were never observed is harmless. A deleted post's
 * readings go with it because their titles quote its first line.
 */
export function deletedPostRecordIds(postId: string, createdMs: number, now: Date): string[] {
  const ids = [postId];
  const lastDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const created = new Date(createdMs);
  let day = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate());
  // Watched posts sit inside a window of at most 365 days.
  for (let n = 0; day <= lastDay && n < 400; n++, day += 86_400_000) {
    ids.push(metricsHistoryRecordId(postId, new Date(day).toISOString().slice(0, 10)));
  }
  return ids;
}
