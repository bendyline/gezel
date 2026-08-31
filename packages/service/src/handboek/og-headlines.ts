import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandboekTocEntry } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { HANDBOEK_AREA_TITLES, WHATS_NEW_INDEX_ID } from './content.js';

/**
 * Poster headlines for the Handboek's Open Graph cards.
 *
 * A card headline has to be far shorter than an article's `summary` (which is
 * capped at 200 characters and reads as a subtitle), so the hand-authored
 * articles get a distilled one. Distillation is a model call, and a docs build
 * must not depend on a provider being reachable — so the results are committed
 * as a lockfile keyed by a hash of the article body, and the build only ever
 * reads it. `scripts/distill-og-headlines.mjs` is what refreshes it.
 */

const log = createLogger('handboek');

export const OG_HEADLINES_FILE = 'og-headlines.json';

/** Longer than this and `bigText` has to shrink past poster scale. */
export const OG_HEADLINE_MAX = 80;

export interface OgHeadlineRecord {
  /** `hashArticleBody` of the body this headline was distilled from. */
  sourceHash: string;
  headline: string;
}

export interface OgHeadlineFile {
  version: 1;
  entries: Record<string, OgHeadlineRecord>;
}

export function emptyOgHeadlineFile(): OgHeadlineFile {
  return { version: 1, entries: {} };
}

/**
 * The text a headline is distilled from, and the thing its `sourceHash`
 * identifies: the article's own claims about itself.
 *
 * Deliberately not the rendered markdown. That is macro-expanded against
 * whichever `@bendyline/gilde` release is pinned, so a content bump would
 * invalidate every headline in the lockfile without a word of prose having
 * changed. Title and summary are authored, stable, and already the material a
 * one-line poster headline is drawn from.
 *
 * Both the build and `scripts/distill-og-headlines.mjs` call this, so the two
 * cannot drift into disagreeing about what a headline is keyed to.
 */
export function ogHeadlineSource(entry: Pick<HandboekTocEntry, 'title' | 'summary'>): string {
  return `${entry.title}\n${entry.summary ?? ''}`;
}

/** Identity of the text a headline was distilled from. */
export function hashArticleBody(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Read the committed lockfile from a content tree. A missing or unreadable
 * file is not an error: every article falls back to its title, which is
 * always present and always short enough.
 */
export function readOgHeadlines(contentDir: string): OgHeadlineFile {
  const path = join(contentDir, OG_HEADLINES_FILE);
  if (!existsSync(path)) return emptyOgHeadlineFile();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as OgHeadlineFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
      throw new Error('missing an `entries` object');
    }
    return { version: 1, entries: parsed.entries };
  } catch (err) {
    log.warn(`ignoring unreadable ${OG_HEADLINES_FILE}: ${String(err)}`);
    return emptyOgHeadlineFile();
  }
}

/**
 * The headline for one article, in precedence order: an author's
 * `ogHeadline` frontmatter, then a lockfile entry distilled from this exact
 * body, then the title.
 *
 * A lockfile entry whose `sourceHash` no longer matches is deliberately
 * ignored rather than used stale — the article has been rewritten since, and
 * a confidently wrong poster line is worse than a plain title.
 */
export function resolveOgHeadline(
  entry: Pick<HandboekTocEntry, 'id' | 'title' | 'summary' | 'ogHeadline'>,
  headlines: OgHeadlineFile,
): string {
  if (entry.ogHeadline?.trim()) return entry.ogHeadline.trim();
  const record = headlines.entries[entry.id];
  if (record && record.sourceHash === hashArticleBody(ogHeadlineSource(entry))) {
    return record.headline;
  }
  return entry.title;
}

/**
 * The card's small title-band line. Derived, never authored — it names the
 * kind of page, so it stays correct as articles are added.
 *
 * Release notes name their version: they are the pages most often shared, and
 * "What's New" alone would not say which release.
 */
export function ogKicker(entry: Pick<HandboekTocEntry, 'id' | 'area'>): string {
  const area = HANDBOEK_AREA_TITLES[entry.area];
  if (entry.area === 'whats-new' && entry.id !== WHATS_NEW_INDEX_ID) {
    const version = entry.id.split('/').pop();
    if (version) return `gezel · ${area} · ${version}`;
  }
  return `gezel · ${area}`;
}
