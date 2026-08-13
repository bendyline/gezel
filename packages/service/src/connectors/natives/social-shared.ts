/**
 * Platform-agnostic helpers for social-posts native adapters. Bluesky ships
 * first; X and Instagram adapters are expected to follow the same corpus
 * shape (month buckets, iso-minute stems, ordered frontmatter), so nothing in
 * this file may know a platform SDK or a platform record shape.
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
    recordId: `metrics:${obs.postId}:${day}`,
    dirSegments: ['metrics-history', ...monthSegments(day)],
    fileStem: `${day}--metrics--${slug(idTail, 32)}`,
    frontmatter: orderedFrontmatter([
      ['title', `Engagement on ${day}: ${obs.title || idTail}`],
      ['date', obs.observedAt],
      ['platform', obs.platform],
      ['post_id', obs.postId],
      ['permalink', obs.permalink],
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
