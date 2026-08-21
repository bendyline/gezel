/**
 * Knowledge-bench corpus: a synthetic, deterministic reference catalog with
 * topically distinct articles and PARAPHRASED golden queries (never verbatim
 * strings, so keyword FTS alone cannot ace the semantic arm). Committed as a
 * generator, not a binary. The catalog is compiled with the daemon's OWN
 * embedder (`embedBatch`), so its profile matches `embedModelId()` and the
 * daemon's semantic two-stage path runs end to end.
 */

import type { CatalogDocument } from '@bendyline/gezel';

export interface KnowledgeGoldenQuery {
  query: string;
  expectedDocumentId: string;
}

interface ArticleSeed {
  id: string;
  topic: string;
  title: string;
  body: string;
}

const ARTICLES: ArticleSeed[] = [
  {
    id: 'dovetail-joints',
    topic: 'joinery',
    title: 'Dovetail Joints',
    body: 'Interlocking tails and pins form a corner joint of exceptional mechanical strength. The flared shape of each tail resists withdrawal along one axis, which is why drawer fronts survive decades of pulling without glue. Cutting tails first and transferring their outline to the pin board with a marking knife is the common hand-tool sequence.',
  },
  {
    id: 'mortise-tenon',
    topic: 'joinery',
    title: 'Mortise and Tenon',
    body: 'The workhorse joint of frame construction: a projecting tenon seats into a matching mortise cavity. Doors, tables, chairs, and timber-framed buildings have relied on it for millennia. Draw-boring pulls the shoulder tight with a slightly offset peg hole.',
  },
  {
    id: 'shellac-finish',
    topic: 'finishing',
    title: 'Shellac',
    body: 'A natural resin secreted by the lac beetle, dissolved in alcohol. It dries within minutes, takes well to padding techniques like French polishing, and repairs invisibly because each fresh coat redissolves the last. Waxy varieties reduce water resistance.',
  },
  {
    id: 'linseed-oil',
    topic: 'finishing',
    title: 'Boiled Linseed Oil',
    body: 'A penetrating oil finish that cures by oxidation. Rags soaked in it can self-ignite as the reaction is exothermic, so they must be dried flat or submerged in water. The finish deepens grain figure but offers little abrasion protection.',
  },
  {
    id: 'card-scraper',
    topic: 'tools',
    title: 'Card Scrapers',
    body: 'A thin plate of hardened steel whose rolled burr shears fibers that tear out under a plane. Preparing the burr with a burnisher at a slight angle produces gossamer shavings on figured hardwoods like curly maple.',
  },
  {
    id: 'sharpening-stones',
    topic: 'tools',
    title: 'Sharpening with Waterstones',
    body: 'Japanese waterstones cut fast because their soft binder constantly exposes fresh abrasive. They must be flattened frequently. A typical progression runs 1000 grit for shaping, 4000 for refining, and 8000 for the final polish on chisels and plane irons.',
  },
  {
    id: 'quarter-sawing',
    topic: 'wood',
    title: 'Quarter-Sawn Lumber',
    body: 'Sawing a log radially yields boards whose growth rings meet the face near ninety degrees. Such boards move half as much across their width as flat-sawn stock and reveal ray fleck in white oak, prized in Arts and Crafts furniture.',
  },
  {
    id: 'wood-movement',
    topic: 'wood',
    title: 'Seasonal Wood Movement',
    body: 'Wood swells and shrinks across the grain as humidity changes, but hardly at all along it. Solid panels must float in frame grooves; a tabletop fastened rigidly across its width will crack or buckle within a season or two.',
  },
];

/** Paraphrased questions — no title words repeated where avoidable. */
export const GOLDEN_QUERIES: KnowledgeGoldenQuery[] = [
  {
    query: 'why do drawer corners stay together for decades even without adhesive',
    expectedDocumentId: 'dovetail-joints',
  },
  {
    query: 'which joint has held chairs and door frames together for thousands of years',
    expectedDocumentId: 'mortise-tenon',
  },
  {
    query: 'a fast-drying finish made from insect resin that can be repaired invisibly',
    expectedDocumentId: 'shellac-finish',
  },
  {
    query: 'can oily rags catch fire on their own after wiping down furniture',
    expectedDocumentId: 'linseed-oil',
  },
  {
    query: 'what hand tool avoids tearout on curly figured boards',
    expectedDocumentId: 'card-scraper',
  },
  {
    query: 'grit progression for getting chisels razor sharp on soft stones',
    expectedDocumentId: 'sharpening-stones',
  },
  {
    query: 'which way of cutting a log makes boards that warp less and show ray patterns',
    expectedDocumentId: 'quarter-sawing',
  },
  {
    query: 'why does a solid table top crack when screwed down tight',
    expectedDocumentId: 'wood-movement',
  },
];

export const KNOWLEDGE_BENCH_TOPICS = [
  { id: 'joinery', name: 'Joinery' },
  { id: 'finishing', name: 'Finishing' },
  { id: 'tools', name: 'Tools' },
  { id: 'wood', name: 'Wood' },
];

export function knowledgeBenchDocuments(): CatalogDocument[] {
  return ARTICLES.map((a) => ({
    id: a.id,
    title: a.title,
    slug: a.id,
    summary: a.body.slice(0, 120),
    language: 'en',
    topicPath: [a.topic],
    markdown: `# ${a.title}\n\n${a.body}\n`,
  }));
}

export interface KnowledgeQueryOutcome {
  query: string;
  /** 1-based rank of the expected document, or null when absent. */
  rank: number | null;
  latencyMs: number;
}

export function scoreKnowledgeOutcomes(outcomes: KnowledgeQueryOutcome[]): {
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  p50Ms: number;
  p95Ms: number;
} {
  const n = outcomes.length || 1;
  const at1 = outcomes.filter((o) => o.rank === 1).length / n;
  const at5 = outcomes.filter((o) => o.rank !== null && o.rank <= 5).length / n;
  const mrr = outcomes.reduce((sum, o) => sum + (o.rank ? 1 / o.rank : 0), 0) / n;
  const sorted = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { recallAt1: at1, recallAt5: at5, mrr, p50Ms: pct(0.5), p95Ms: pct(0.95) };
}
