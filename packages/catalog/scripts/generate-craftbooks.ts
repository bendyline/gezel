#!/usr/bin/env node
/**
 * Generate the gallery craftbooks from archetype specs.
 *
 * Reads `SEED_ARCHETYPES`, turns each into a bundled craftbook under
 * `data/craftbook-templates/{shard}/{id}/` (identity manifest + 1.0.0
 * version manifest + about.md), and reports what it wrote. Each book is
 * schema-validated inside `archetypeToFiles` before it touches disk, so a
 * malformed spec fails the run loudly instead of poisoning the catalog.
 *
 * This is the deterministic core of the gallery pipeline: scaling to the
 * full 300-400 means adding specs to `craftbook-archetypes.ts` (by hand,
 * or by an LLM that drafts the small spec — never raw craftbook JSON).
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog generate-craftbooks
 *   # then refresh the index so the new books are discoverable:
 *   pnpm --filter @bendyline/gezel-catalog build-index --kind=craftbook-template
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ArchetypeSpec } from '../src/archetype.js';
import { archetypeToFiles } from '../src/archetype.js';
import { SEED_ARCHETYPES } from './craftbook-archetypes.js';
import { requireGildeCheckout } from './gilde-checkout.js';
import { MAINTENANCE_REVIEW_ARCHETYPES } from './maintenance-review-archetypes.js';

// Fixed release date so re-running is byte-stable (no git churn on identical
// input — same rationale as build-index dropping its generatedAt stamp).
const RELEASED_AT = '2026-06-05T00:00:00Z';

/**
 * Load the gallery specs drafted into `scripts/gallery-specs/*.json` (one
 * JSON array per taxonomy family, written by the gallery-200 workflow). Each
 * spec is schema-validated downstream in `archetypeToFiles`; here we only
 * parse + flatten. Missing dir → no extra specs (seeds-only run).
 */
async function loadGallerySpecs(here: string): Promise<ArchetypeSpec[]> {
  const dir = resolve(here, 'gallery-specs');
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const specs: ArchetypeSpec[] = [];
  for (const file of entries) {
    const raw = await readFile(join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`  ⚠ ${file}: invalid JSON, skipped (${(err as Error).message})`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      console.warn(`  ⚠ ${file}: not a JSON array, skipped`);
      continue;
    }
    specs.push(...(parsed as ArchetypeSpec[]));
  }
  return specs;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(requireGildeCheckout().dataDir, 'craftbook-templates');

  // Curated, hand-authored bundled craftbooks that are NOT generated from a
  // SEED_ARCHETYPE — the generic loop, the QA/ship/review books, etc. Gallery
  // specs that re-derive one of these (the taxonomy lists some) must be
  // skipped so we never clobber the curated version on disk.
  const HAND_AUTHORED = [
    'build-loop',
    'qa',
    'ship',
    'reviewer-loop',
    'investigate',
    'office-hours',
    'pull-request-review',
    'plan',
    // These began as gallery archetypes, but their released successors are
    // curated DocBlocks workflows. Keep the legacy specs for taxonomy
    // history without letting regeneration overwrite immutable releases.
    'report-pdf',
    'narrated-slideshow',
  ];

  // Seeds + curated books are authoritative. Gallery specs add NEW ids; any
  // that collide are skipped. Dedup gallery ids against each other too.
  const authored = [...SEED_ARCHETYPES, ...MAINTENANCE_REVIEW_ARCHETYPES];
  const seedIds = new Set([...authored.map((s) => s.id), ...HAND_AUTHORED]);
  const gallery = await loadGallerySpecs(here);
  const seenGalleryIds = new Set<string>();
  const galleryToWrite: ArchetypeSpec[] = [];
  let skippedDup = 0;
  for (const spec of gallery) {
    if (!spec || typeof spec.id !== 'string') {
      console.warn('  ⚠ gallery spec missing id, skipped');
      continue;
    }
    if (seedIds.has(spec.id) || seenGalleryIds.has(spec.id)) {
      skippedDup++;
      continue;
    }
    seenGalleryIds.add(spec.id);
    galleryToWrite.push(spec);
  }

  const all = [...authored, ...galleryToWrite];
  let written = 0;
  const failures: { id: string; error: string }[] = [];
  for (const spec of all) {
    try {
      const gen = archetypeToFiles(spec, RELEASED_AT);
      const bookDir = join(root, gen.shard, gen.id);
      for (const f of gen.files) {
        const dest = join(bookDir, f.relPath);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
      }
      written++;
    } catch (err) {
      // One malformed agent-authored spec must not block the other ~200.
      failures.push({ id: spec?.id ?? '<no-id>', error: (err as Error).message });
    }
  }

  console.log(
    `\nGenerated ${written} craftbook(s) (${authored.length} authored + ${galleryToWrite.length} gallery; ${skippedDup} dup-id skipped) into ${root}`,
  );
  if (failures.length > 0) {
    console.warn(`\n${failures.length} spec(s) failed validation and were skipped:`);
    for (const f of failures) console.warn(`  ✗ ${f.id}: ${f.error.split('\n')[0]}`);
  }
  console.log('Next: pnpm --filter @bendyline/gezel-catalog build-index --kind=craftbook-template');
}

main().catch((err) => {
  console.error('generate-craftbooks failed:', err);
  process.exit(1);
});
