import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandboekArea } from '@bendyline/gezel';
import { HandboekAreaSchema, createLogger } from '@bendyline/gezel';
import { parseFrontmatter, splitFrontmatterBlock } from '@bendyline/squisq/markdown';

const log = createLogger('handboek');

/** Area folder order — also the TOC order. */
export const HANDBOEK_AREAS: readonly HandboekArea[] = [
  'conceptual',
  'gezel-roles',
  'craftbooks',
  'project-types',
  'technical',
  'whats-new',
];

export const HANDBOEK_AREA_TITLES: Record<HandboekArea, string> = {
  conceptual: 'Concepts',
  'gezel-roles': 'Gezel Roles',
  craftbooks: 'Craftbooks',
  'project-types': 'Project Types',
  technical: 'Technical',
  'whats-new': "What's New",
};

/**
 * The `whats-new` section index. Excluded from its own release list, and
 * the one article in that area whose `order` is not a negated calendar
 * line — see `docs/handboek/README.md`.
 */
export const WHATS_NEW_INDEX_ID = 'whats-new-index';

/** One release, as the `whats-new-list` macro renders it. */
export interface ReleaseNoteEntry {
  /** Article id — link targets resolve ids directly in app and site. */
  id: string;
  title: string;
  /** The tweet-sized line. Absent only if an author forgot one. */
  summary?: string;
}

export interface CuratedArticle {
  id: string;
  area: HandboekArea;
  title: string;
  order: number;
  summary?: string;
  /** Article body — squisq-flavored markdown, macros not yet expanded. */
  body: string;
  /** Per-block seconds override for video playback. */
  defaultDuration?: number;
  /** When false, the CLI static-site export skips the article. */
  siteVisible: boolean;
}

/**
 * Locate the shipped handboek content tree. Same probe-chain shape as
 * `findBundledUi()` in bin/gezeld.ts: an env override for tests and
 * operators, the tsup-copied `dist/handboek-content/` in built trees,
 * and the repo `docs/handboek/` when running from source (vitest, tsx).
 */
export function findHandboekContent(): string | null {
  const override = process.env.GEZEL_HANDBOEK_DIR?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/handboek.js or dist/index.js → dist/handboek-content/
    join(here, 'handboek-content'),
    // dist/bin/gezeld.js → dist/handboek-content/. The daemon binary is the
    // one entry point that does NOT sit directly in dist/, and it is the
    // only one an npm install runs. Without this the daemon logged "no
    // handboek content tree found" for every consumer while quietly working
    // in this repo, where the docs/handboek fallbacks below still resolve.
    join(here, '..', 'handboek-content'),
    // src/handboek/content.ts → repo docs/handboek/
    join(here, '..', '..', '..', '..', 'docs', 'handboek'),
    // dist/ in a source checkout where the copy step didn't run
    join(here, '..', '..', '..', 'docs', 'handboek'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'conceptual'))) return resolve(dir);
  }
  return null;
}

/**
 * Read every curated article under the content tree. The area folder is
 * authoritative for `area`; frontmatter supplies id/title/order/summary.
 * Malformed files are skipped with a warning rather than failing the
 * whole handboek — one bad article shouldn't hide the rest.
 */
export function loadCuratedArticles(contentDir: string): CuratedArticle[] {
  const out: CuratedArticle[] = [];
  for (const area of HANDBOEK_AREAS) {
    const areaDir = join(contentDir, area);
    if (!existsSync(areaDir)) continue;
    const files = readdirSync(areaDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    for (const file of files) {
      const path = join(areaDir, file);
      try {
        const article = parseCuratedArticle(readFileSync(path, 'utf8'), area, file);
        if (article) out.push(article);
      } catch (err) {
        log.warn(`skipping unreadable handboek article ${path}: ${String(err)}`);
      }
    }
  }
  out.sort((a, b) => (a.area === b.area ? a.order - b.order : 0));
  return out;
}

/**
 * Release-note articles, newest first. Release `order` is the negated
 * calendar line (`1.26224` → `-26224`), so the area's own ascending sort
 * already puts the newest release on top; this only drops the section
 * index out of the list it introduces.
 */
export function listReleaseNotes(articles: CuratedArticle[]): ReleaseNoteEntry[] {
  return articles
    .filter((a) => a.area === 'whats-new' && a.id !== WHATS_NEW_INDEX_ID)
    .sort((a, b) => a.order - b.order)
    .map((a) => ({ id: a.id, title: a.title, summary: a.summary }));
}

export function parseCuratedArticle(
  source: string,
  area: HandboekArea,
  filename: string,
): CuratedArticle | null {
  HandboekAreaSchema.parse(area);
  const { frontmatter, body } = splitFrontmatterBlock(source);
  const fm = frontmatter
    ? (parseFrontmatter(frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---(\r?\n)?$/, '')) ??
      {})
    : {};
  const stem = filename.replace(/\.md$/, '');
  const id = typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : stem;
  const title =
    typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : titleFromBody(body, stem);
  const order = typeof fm.order === 'number' ? fm.order : 999;
  const summary =
    typeof fm.summary === 'string' && fm.summary.trim() ? fm.summary.trim() : undefined;
  const defaultDuration =
    typeof fm.defaultDuration === 'number' && fm.defaultDuration > 0
      ? fm.defaultDuration
      : undefined;
  const siteVisible = fm.siteVisible !== false;
  const trimmed = body.trim();
  if (!trimmed) return null;
  return { id, area, title, order, summary, body: trimmed, defaultDuration, siteVisible };
}

function titleFromBody(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  if (m) {
    // Strip a trailing squisq template annotation from the heading text.
    return m[1]!.replace(/\s*\{\[.*\]\}\s*$/, '').trim() || fallback;
  }
  return fallback;
}
