import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isOgRendererReady, renderOgCard } from '@bendyline/gezel-service/handboek';

/**
 * Open Graph cards for the static site.
 *
 * The cards are written **outside** the export's `--out` directory, because
 * `--out` is wiped on every run and the card set is its own cache: a card is
 * only re-rendered when its text changes. That matters — a render costs about
 * a second of headless Chromium and the catalog alone is ~320 articles, so a
 * cold pass is minutes and a typical docs publish should be seconds.
 *
 * It follows the rule `handboek.css` and `releases.json` already follow: what
 * must survive regeneration lives at the site root, not under `docs/`.
 */

const MANIFEST = 'manifest.json';

export interface OgCardPlan {
  /** Article id — also the card's path under the output dir. */
  id: string;
  kicker: string;
  headline: string;
}

export interface OgCardsResult {
  rendered: number;
  reused: number;
  swept: number;
  /** Set when the whole pass was skipped; the reason, for the caller to log. */
  skipped?: string;
  /** Ids whose render failed. Those pages fall back to the site-wide card. */
  failed: string[];
}

interface Manifest {
  version: 1;
  cards: Record<string, { specHash: string }>;
}

/** The card's relative path under the output dir, and under the site URL. */
export function ogCardPath(id: string): string {
  return `${id}.png`;
}

function specHash(plan: OgCardPlan): string {
  // Only the rendered text participates. Changing an article's body without
  // changing its headline must not re-render an identical card.
  return createHash('sha256').update(plan.kicker).update('\n').update(plan.headline).digest('hex');
}

async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return { version: 1, cards: {} };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Manifest;
    if (!parsed || typeof parsed.cards !== 'object') throw new Error('no `cards` object');
    return { version: 1, cards: parsed.cards };
  } catch {
    // An unreadable manifest costs a full re-render, never a wrong card.
    return { version: 1, cards: {} };
  }
}

/** Every `.png` under `dir`, as ids relative to it with POSIX separators. */
async function existingCardIds(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.name.endsWith('.png')) {
        out.push(
          relative(dir, full)
            .split(sep)
            .join('/')
            .replace(/\.png$/, ''),
        );
      }
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

/**
 * Render every plan whose text has changed, drop cards for articles that no
 * longer exist, and rewrite the manifest.
 *
 * A single card's failure is never fatal: the page keeps its other metadata
 * and falls back to the site-wide card, the same posture the export already
 * takes toward a `releases.json` refresh that could not reach GitHub.
 */
export async function writeOgCards(opts: {
  home: string;
  dir: string;
  plans: OgCardPlan[];
  onProgress?: (done: number, total: number) => void;
}): Promise<OgCardsResult> {
  const { home, dir, plans } = opts;
  if (!(await isOgRendererReady(home))) {
    return {
      rendered: 0,
      reused: 0,
      swept: 0,
      failed: [],
      skipped: `managed Chromium is not installed under ${home} — launch the app once to let it download, then re-run`,
    };
  }

  const manifest = await readManifest(dir);
  const next: Manifest = { version: 1, cards: {} };
  const result: OgCardsResult = { rendered: 0, reused: 0, swept: 0, failed: [] };

  let done = 0;
  for (const plan of plans) {
    const hash = specHash(plan);
    const file = join(dir, ...ogCardPath(plan.id).split('/'));
    if (manifest.cards[plan.id]?.specHash === hash && existsSync(file)) {
      next.cards[plan.id] = { specHash: hash };
      result.reused += 1;
    } else {
      try {
        const png = await renderOgCard(home, { kicker: plan.kicker, headline: plan.headline });
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, png);
        next.cards[plan.id] = { specHash: hash };
        result.rendered += 1;
      } catch {
        result.failed.push(plan.id);
      }
    }
    done += 1;
    opts.onProgress?.(done, plans.length);
  }

  const wanted = new Set(plans.map((p) => p.id));
  for (const id of await existingCardIds(dir)) {
    if (wanted.has(id)) continue;
    await rm(join(dir, ...ogCardPath(id).split('/')), { force: true });
    result.swept += 1;
  }

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return result;
}
