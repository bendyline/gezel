#!/usr/bin/env node
/**
 * Generate the gallery craftbooks from archetype specs.
 *
 * Reads `SEED_ARCHETYPES`, turns each into a bundled craftbook under
 * `data/craftbook-templates/{shard}/{id}/` (identity manifest + 1.0.0
 * immutable version document), and reports what it wrote. Each book is
 * schema-validated inside `archetypeToFiles` before it touches disk, so a
 * malformed spec fails the run loudly instead of poisoning the catalog.
 *
 * This is the deterministic core of the gallery pipeline: scaling to the
 * full 300-400 means adding specs to `craftbook-archetypes.ts` (by hand,
 * or by an LLM that drafts the small spec — never raw craftbook JSON).
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog generate-craftbooks
 *   pnpm --filter @bendyline/gezel-catalog generate-craftbooks -- --only=foo,bar
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

// Default release date for legacy specs. Revised seeds carry their own
// explicit release metadata so regeneration creates a new immutable version
// rather than rewriting their released 1.0.0 document.
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

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * A new immutable craftbook release keeps the previous release's eval
 * sidecar unless an author has already supplied a test for the new version.
 * This prevents catalog-wide compiler migrations from silently dropping
 * evaluation coverage.
 */
async function inheritLatestTestSidecar(bookDir: string, targetVersion: string): Promise<void> {
  const versionsDir = join(bookDir, 'versions');
  const target = join(versionsDir, targetVersion, 'test.json');
  try {
    await readFile(target);
    return;
  } catch {
    // Expected for a new immutable release.
  }

  let versions: string[];
  try {
    versions = (await readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .filter((version) => version !== targetVersion)
      .sort(compareSemver)
      .reverse();
  } catch {
    return;
  }

  for (const version of versions) {
    try {
      const bytes = await readFile(join(versionsDir, version, 'test.json'));
      await writeFile(target, bytes);
      return;
    } catch {
      // Keep looking for the newest release that carries an eval sidecar.
    }
  }
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
  const onlyArg = process.argv.slice(2).find((arg) => arg.startsWith('--only='));
  const onlyIds = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      )
    : null;
  const selected = onlyIds ? all.filter((spec) => onlyIds.has(spec.id)) : all;
  if (onlyIds) {
    const missing = [...onlyIds].filter((id) => !selected.some((spec) => spec.id === id));
    if (missing.length > 0) {
      throw new Error(`unknown --only craftbook id(s): ${missing.join(', ')}`);
    }
  }
  let written = 0;
  const failures: { id: string; error: string }[] = [];
  for (const spec of selected) {
    try {
      const gen = archetypeToFiles(spec, RELEASED_AT);
      const bookDir = join(root, gen.shard, gen.id);
      for (const f of gen.files) {
        const dest = join(bookDir, f.relPath);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
      }
      const version = spec.release?.version ?? '1.0.0';
      await inheritLatestTestSidecar(bookDir, version);
      written++;
    } catch (err) {
      // One malformed agent-authored spec must not block the other ~200.
      failures.push({ id: spec?.id ?? '<no-id>', error: (err as Error).message });
    }
  }

  console.log(
    `\nGenerated ${written} craftbook(s)${onlyIds ? ` selected by --only (${[...onlyIds].join(', ')})` : ` (${authored.length} authored + ${galleryToWrite.length} gallery; ${skippedDup} dup-id skipped)`} into ${root}`,
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
