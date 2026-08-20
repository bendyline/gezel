/**
 * Retrieval-arm liveness contract: every arm the unified search fans out to
 * must return at least one hit on a golden fixture. This is the regression
 * net for the fts_summaries class of failure — an arm that silently goes
 * write-only, or whose floor drifts off the embedder's scale — which
 * previously survived for months because nothing asserted arms end-to-end.
 *
 * Where a downstream consumer applies a floor (memory/recall.ts's
 * CODE_MIN_SCORE / LIBRARY_MIN_SCORE), the assertion is "clears the floor",
 * not merely "returns rows": a floor drift produces exactly the silent-empty
 * failure this file exists to catch.
 *
 * Uses the real local embedder (MiniLM pinned, same rationale as
 * content-enrich.test.ts) and self-skips when embeddings are unavailable.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const priorEmbedModel = process.env.GEZEL_EMBED_MODEL;
beforeAll(() => {
  process.env.GEZEL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
});
afterAll(() => {
  if (priorEmbedModel === undefined) delete process.env.GEZEL_EMBED_MODEL;
  else process.env.GEZEL_EMBED_MODEL = priorEmbedModel;
});
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';

// Minimal valid PNG header declaring 800x600 (same fixture as content-images).
const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-arms-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-arms-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
      projectIndexingEnabled: async () => true,
    } as unknown as Store,
    home,
    { artifactsDebounceMs: 0 },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function realEmbed(): Promise<((texts: string[]) => Promise<number[][]>) | null> {
  try {
    const { embedBatch } = await import('../memory/embeddings.js');
    await embedBatch(['warmup']);
    return embedBatch;
  } catch {
    return null;
  }
}

it('every retrieval arm returns a hit on the golden fixture, clearing its floor', async () => {
  const embed = await realEmbed();
  if (!embed) return; // embeddings unavailable here — skip

  // ── fixture: code ×2 (area rollups need ≥2 files per folder), markdown,
  //    text, an image, and one artifact record ────────────────────────────
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'src', 'throttle.ts'),
    'export function rateLimit(req: Request) { /* limits how many API requests per second a client may make */ return true; }\n',
  );
  await writeFile(
    join(dir, 'src', 'palette.ts'),
    'export const palette = ["#fff", "#000"]; /* colour swatches for theming */\n',
  );
  await writeFile(
    join(dir, 'README.md'),
    '# Vehicle physics\n\nSuspension damping controls how the car responds to bumps.\n',
  );
  await writeFile(join(dir, 'notes.txt'), 'The deployment runbook lives on the staging server.\n');
  await writeFile(join(dir, 'photos.png'), PNG_800x600);
  // The artifacts corpus walks only <artifacts>/data/** (artifacts-indexer
  // CORPUS_ROOT) — records elsewhere are deliberately outside the index.
  await mkdir(join(artifacts, 'data', 'reports'), { recursive: true });
  await writeFile(
    join(artifacts, 'data', 'reports', 'audit.md'),
    '# Quarterly audit\n\nInvoice reconciliation found three mismatched totals.\n',
  );
  await runWorkspaceContentIndex(dir, 'c', artifacts);

  // ── AI tiers with a content-aware mock summarizer + real embedder ───────
  const describeImage = vi.fn(async () => ({
    body: 'A lighthouse on a rocky coast at dusk.',
    model: 'vision-test',
  }));
  await ci.aiShadows('c', { describeImage }, 5);
  const deps: EnrichDeps = {
    summarize: async (prompt: string) =>
      prompt.includes('palette')
        ? 'Defines a colour palette of hex swatches for theming.'
        : prompt.includes('rateLimit')
          ? 'Implements rate limiting and throttling for incoming API requests.'
          : prompt.includes('Suspension')
            ? 'Explains vehicle suspension damping behavior.'
            : 'Notes about the deployment runbook and staging.',
    embed,
    model: 'test',
  };
  await ci.enrich('c', deps, 20);
  await ci.enrichAreas('c', deps);
  await ci.refreshArtifacts('c');

  // ── arm: keyword code search (fts_symbols) ──────────────────────────────
  const keyword = await ci.searchCode('c', 'rateLimit', { mode: 'keyword' });
  expect(keyword.engine).toBe('fts');
  expect(keyword.results.some((r) => r.path === 'src/throttle.ts')).toBe(true);

  // ── arm: semantic code search (vec_text), clearing recall.ts's
  //    CODE_MIN_SCORE (0.45) — the floor a scale drift silently breaks ─────
  const semantic = await ci.searchCode('c', 'how do we limit API request rate?', {
    mode: 'semantic',
  });
  expect(semantic.engine).toBe('semantic');
  expect(semantic.results[0]?.path).toBe('src/throttle.ts');
  expect(semantic.results[0]?.score).toBeGreaterThanOrEqual(0.45);

  // ── arm: doc-chunk keyword search (fts_docs) ────────────────────────────
  const docs = await ci.searchDocs('c', 'suspension damping');
  expect(docs.results.some((r) => r.sourcePath === 'README.md')).toBe(true);

  // ── arm: symbol lookup ──────────────────────────────────────────────────
  const symbols = await ci.findSymbol('c', 'rateLimit', { maxResults: 5 });
  expect(symbols.matches.some((m) => m.path === 'src/throttle.ts')).toBe(true);

  // ── arm: area rollups (lexical over area summaries) ─────────────────────
  const areas = await ci.searchAreaSummaries('c', 'rate limiting palette', 5);
  expect(areas.length).toBeGreaterThan(0);

  // ── arm: artifacts corpus ───────────────────────────────────────────────
  const artifactHits = await ci.searchArtifacts('c', 'invoice reconciliation', 5);
  expect(artifactHits.results.some((r) => r.path === 'data/reports/audit.md')).toBe(true);

  // ── arm: shared-library search (hybrid), clearing recall.ts's
  //    LIBRARY_MIN_SCORE (0.5) ─────────────────────────────────────────────
  const library = await ci.searchLibrary('c', 'vehicle suspension damping');
  const readme = library.results.find((r) => r.path === 'README.md');
  expect(readme).toBeDefined();
  expect(readme?.score ?? 0).toBeGreaterThanOrEqual(0.5);

  // ── arm: AI-shadow text reaches search (vision caption → chunks) ────────
  const caption = await ci.searchDocs('c', 'lighthouse rocky coast');
  expect(caption.results.some((r) => r.sourcePath === 'photos.png')).toBe(true);
}, 120_000);
