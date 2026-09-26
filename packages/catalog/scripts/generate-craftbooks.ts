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
 *   pnpm --filter @bendyline/gezel-catalog generate-craftbooks -- --dry-run
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
  const dryRun = process.argv.slice(2).includes('--dry-run');

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
    // Tactical-fleet v2: these ids are now owned by the tactical compiled
    // track (gilde authoring/tactical/ + generate-tactical-craftbooks.ts).
    // Their gallery specs stay as taxonomy history; regeneration must never
    // resurrect the 1.0.x graphs over the fleet releases.
    'bug-fix-tdd',
    'hotfix-flow',
    'refactor-module',
    'perf-optimization',
    'type-safety-pass',
    'schema-migration',
    'test-suite-backfill',
    'ci-pipeline',
    'accessibility-retrofit',
    // Retired (tombstoned) ids absorbed by fleet survivors — never
    // regenerate a version for a tombstoned identity.
    'investigate-root-cause',
    'release-pipeline-ci',
    'feature-flag-release',
    'alt-text-pass',
    'live-browser-qa',
    'changelog-cut',
    'changelog-writeup',
    'runbook',
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
  const plans: Array<{
    spec: ArchetypeSpec;
    generated: ReturnType<typeof archetypeToFiles>;
    bookDir: string;
    version: string;
    targetExists: boolean;
  }> = [];
  const failures: { id: string; error: string }[] = [];
  for (const spec of selected) {
    try {
      const generated = archetypeToFiles(spec, RELEASED_AT);
      const bookDir = join(root, generated.shard, generated.id);
      const version = spec.release?.version ?? '1.0.0';
      const versionFile = generated.files.find(
        (file) => file.relPath === join('versions', version, 'craftbook.json'),
      );
      if (!versionFile) {
        throw new Error(`generated release ${version} has no craftbook payload`);
      }
      let targetExists = false;
      try {
        const current = await readFile(join(bookDir, versionFile.relPath), 'utf8');
        targetExists = true;
        if (current !== versionFile.content) {
          throw new Error(
            `refusing to rewrite immutable release ${generated.id}@${version}; bump the spec release version`,
          );
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
      plans.push({ spec, generated, bookDir, version, targetExists });
    } catch (err) {
      // One malformed agent-authored spec must not block the other ~200.
      failures.push({ id: spec?.id ?? '<no-id>', error: (err as Error).message });
    }
  }

  // Validate every selected release before the first write. A stale source
  // version must never partially rewrite hundreds of immutable payloads and
  // manifests before the conflict is noticed.
  const immutableConflicts = failures.filter((failure) =>
    failure.error.startsWith('refusing to rewrite immutable release'),
  );
  if (immutableConflicts.length > 0) {
    const preview = immutableConflicts
      .slice(0, 20)
      .map((failure) => `  - ${failure.error}`)
      .join('\n');
    const remainder =
      immutableConflicts.length > 20 ? `\n  …and ${immutableConflicts.length - 20} more` : '';
    throw new Error(
      `append-only preflight found ${immutableConflicts.length} immutable release conflict(s):\n${preview}${remainder}`,
    );
  }

  const toWrite = plans.filter((plan) => !plan.targetExists);
  if (!dryRun) {
    for (const plan of toWrite) {
      for (const file of plan.generated.files) {
        const dest = join(plan.bookDir, file.relPath);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.content, 'utf8');
      }
      await inheritLatestTestSidecar(plan.bookDir, plan.version);
    }
  }

  console.log(
    `\n${dryRun ? 'Would generate' : 'Generated'} ${toWrite.length} craftbook(s); ${plans.length - toWrite.length} existing release(s) unchanged${onlyIds ? ` selected by --only (${[...onlyIds].join(', ')})` : ` (${authored.length} authored + ${galleryToWrite.length} gallery; ${skippedDup} dup-id skipped)`} into ${root}`,
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
