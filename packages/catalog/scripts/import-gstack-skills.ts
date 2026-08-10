/**
 * Convert the committed skill snapshot into bundled craftbook-templates.
 *
 *   pnpm --filter @bendyline/gezel-catalog exec tsx scripts/import-gstack-skills.ts [--dry-run]
 *   pnpm --filter @bendyline/gezel-catalog exec tsx scripts/import-gstack-skills.ts --tests-only
 *   pnpm --filter @bendyline/gezel-catalog run build-index
 *
 * Sources are the snapshot under
 * `../gilde/authoring/gstack/snapshots/<source>/SKILL.md` (committed —
 * regeneration must not depend on a live ../gstack checkout), adapted from
 * gstack (Garry Tan's stack — github.com/garrytan/gstack). They ship as
 * ordinary gezel skills: plain, role-safe ids/names and release metadata
 * live in Gilde's `authoring/gstack/wave.json`; the user-facing source
 * credit lives only in each document's structured `basedOn` field.
 *
 * Hand-tuning lives in `../gilde/authoring/gstack/overlays/<source>.json`,
 * applied AFTER conversion so edits survive re-runs by construction:
 *
 *   {
 *     "frozen": true,              // book is fully hand-owned — skip regen
 *     "set": { ...doc fields },    // shallow field replacement
 *     "planAppend": "…",           // paragraph appended to plan (regen-stable guidance)
 *     "steps": { "<id>": {…}|null }, // patch or remove a step by id
 *     "scripts": { "<n>": "…"|null },
 *     "hooks": [ …HookSpec ]
 *   }
 *
 * Detected personas are NOT shipped automatically: the draft about is
 * written to `../gilde/authoring/gstack/persona-drafts/<source>.about.md` for
 * hand review (about.md diet rules apply before anything lands in
 * gezel-templates).
 *
 * Safety: the configured version is append-only. A non-dry run preflights
 * the entire wave and refuses to write when ANY target version directory
 * already exists. Bump version + releasedAt in wave.json for every released
 * content change; never use this importer to edit a release in place.
 * `--tests-only` is the recovery path when the append-only craftbook pass
 * completed before its test fixtures: it requires each configured version directory
 * and craftbook.json to exist, then writes only a missing test.json. It also
 * refuses overwrites.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  craftbookFromDoc,
  formatCraftbookDocErrors,
  parseCraftbookTestSpec,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { gstackAuthoringDir, readGstackWaveConfig } from '../src/gstack-authoring.js';
import {
  type Overlay,
  OverlaySchema,
  convertSnapshotSkill,
  mergeWaveIdentity,
} from '../src/gstack-import.js';
import { requireGildeCheckout } from './gilde-checkout.js';

export async function readOverlay(source: string, overlayRoot: string): Promise<Overlay> {
  const path = join(overlayRoot, `${source}.json`);
  try {
    return OverlaySchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    throw new Error(
      `${source}: missing or invalid overlay ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function readTestSpecBytes(source: string, evalRoot: string): Promise<string> {
  const path = join(evalRoot, `${source}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `${source}: missing or invalid eval source ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const parsed = parseCraftbookTestSpec(raw);
  if (!parsed.ok) {
    throw new Error(`${source}: invalid eval source ${path}:\n${parsed.errors.join('\n')}`);
  }
  return `${JSON.stringify(parsed.spec, null, 2)}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const gilde = requireGildeCheckout();
  const authoringRoot = gstackAuthoringDir(gilde.root);
  const snapshotRoot = join(authoringRoot, 'snapshots');
  const overlayRoot = join(authoringRoot, 'overlays');
  const evalRoot = join(authoringRoot, 'evals');
  const personaRoot = join(authoringRoot, 'persona-drafts');
  const dataRoot = join(gilde.dataDir, 'craftbook-templates');
  const wave = readGstackWaveConfig(gilde.root);
  const dryRun = process.argv.includes('--dry-run');
  const testsOnly = process.argv.includes('--tests-only');
  let written = 0;
  let skipped = 0;
  const personaDrafts: string[] = [];
  const testBytes = new Map<string, string>();

  // Validate every shipped eval descriptor before the first generated write.
  // A craftbook version without its matching test.json is not a complete
  // catalog release.
  for (const book of wave.books) {
    const overlay = await readOverlay(book.source, overlayRoot);
    if (overlay.frozen) continue;
    testBytes.set(book.source, await readTestSpecBytes(book.source, evalRoot));
  }

  // Check the whole wave before the first write so a collision cannot leave
  // a half-generated release. An existing directory may be a published
  // version or an interrupted draft; both require a deliberate new version
  // or manual recovery, never an overwrite.
  if (!dryRun && !testsOnly) {
    const collisions: string[] = [];
    for (const book of wave.books) {
      const overlay = await readOverlay(book.source, overlayRoot);
      if (overlay.frozen) continue;
      const versionDir = join(
        dataRoot,
        book.id.slice(0, 2).toLowerCase(),
        book.id,
        'versions',
        wave.version,
      );
      try {
        await access(versionDir);
        collisions.push(`${book.id}: ${versionDir}`);
      } catch {
        // Expected: the configured version must be new across the entire generated wave.
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `refusing to overwrite existing gilde version ${wave.version}:\n${collisions.map((line) => `  - ${line}`).join('\n')}\nBump version and releasedAt in authoring/gstack/wave.json before regenerating.`,
      );
    }
  }

  if (!dryRun && testsOnly) {
    const problems: string[] = [];
    for (const book of wave.books) {
      const overlay = await readOverlay(book.source, overlayRoot);
      if (overlay.frozen) continue;
      const versionDir = join(
        dataRoot,
        book.id.slice(0, 2).toLowerCase(),
        book.id,
        'versions',
        wave.version,
      );
      const craftbookPath = join(versionDir, 'craftbook.json');
      const testPath = join(versionDir, 'test.json');
      if (!(await pathExists(craftbookPath))) {
        problems.push(`${book.id}: missing ${craftbookPath}`);
      }
      if (await pathExists(testPath)) {
        problems.push(`${book.id}: refusing to overwrite ${testPath}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`cannot generate ${wave.version} test sidecars:\n${problems.join('\n')}`);
    }
  }

  for (const book of wave.books) {
    const overlay = await readOverlay(book.source, overlayRoot);
    if (overlay.frozen) {
      skipped++;
      console.log(`  ~ ${book.id}: frozen overlay — hand-owned, skipping regen`);
      continue;
    }

    const raw = await readFile(join(snapshotRoot, book.source, 'SKILL.md'), 'utf8');
    const converted = convertSnapshotSkill(book, raw, overlay, wave);
    const { doc } = converted;
    const testJson = testBytes.get(book.source)!;

    // The same bar craftbook_write holds: the doc must expand into a
    // valid runtime craftbook or the build fails loudly.
    const runtime = craftbookFromDoc(doc, { now: wave.releasedAt });
    if (!runtime.ok) {
      throw new Error(
        `${book.id}: converted doc failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
    }

    const shard = book.id.slice(0, 2).toLowerCase();
    const bookDir = join(dataRoot, shard, book.id);
    const versionDir = join(bookDir, 'versions', wave.version);

    if (testsOnly) {
      if (dryRun) {
        console.log(`  ✓ ${book.id}: ${wave.version} test.json validated (tests-only dry run)`);
        continue;
      }
      await writeFile(join(versionDir, 'test.json'), testJson);
      written++;
      console.log(`  ✓ ${book.id}: test.json → ${join(shard, book.id, 'versions', wave.version)}`);
      continue;
    }

    if (converted.persona) {
      const draftPath = join(personaRoot, `${book.source}.about.md`);
      if (!dryRun) {
        await mkdir(personaRoot, { recursive: true });
        await writeFile(
          draftPath,
          `<!-- DRAFT persona for ${book.id} (role: ${converted.persona.role}). Hand-review + diet before shipping as a gezel-template. -->\n\n${converted.persona.about}`,
        );
      }
      personaDrafts.push(`${book.id} (${converted.persona.role})`);
    }

    const manifestPath = join(bookDir, 'manifest.json');
    let existingIdentity: Record<string, unknown> = {};
    try {
      existingIdentity = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // First release of a newly imported identity.
    }
    const identity = mergeWaveIdentity(existingIdentity, book, doc);

    if (dryRun) {
      console.log(
        `  ✓ ${book.id}: ${doc.steps.length} step(s)${converted.notes.length ? ` — notes: ${converted.notes.join('; ')}` : ''}`,
      );
      continue;
    }
    await mkdir(versionDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(identity, null, 2)}\n`);
    await writeFile(join(versionDir, 'craftbook.json'), serializeCraftbookDoc(doc, 'json'));
    await writeFile(join(versionDir, 'test.json'), testJson);
    written++;
    console.log(`  ✓ ${book.id}: ${doc.steps.length} step(s) → ${join(shard, book.id)}`);
  }

  if (personaDrafts.length > 0) {
    console.log(`\npersona drafts (hand-review before shipping): ${personaDrafts.join(', ')}`);
  }
  console.log(
    `\ndone: ${written} ${testsOnly ? 'test sidecar(s)' : 'version(s)'} written, ${skipped} frozen${dryRun ? ` (dry run for ${wave.version})` : ` at ${wave.version}`}`,
  );
  if (!dryRun) {
    console.log(
      'Next: pnpm --filter @bendyline/gezel-catalog run build-index --kind=craftbook-template',
    );
  }
}

// Import-safe: the regen test imports the helpers above without running
// the writer. Only execute when invoked as a script.
if (process.argv[1]?.endsWith('import-gstack-skills.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
