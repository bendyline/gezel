/**
 * Compile the tactical fleet sources into bundled craftbook-templates.
 *
 *   pnpm --filter @bendyline/gezel-catalog exec tsx scripts/generate-tactical-craftbooks.ts [--dry-run] [--only <id>[,<id>…]]
 *   (then, in ../gilde: npm run fix && npm run check)
 *
 * Sources live in Gilde's `authoring/tactical/`:
 *
 *   wave.json          — release mapping: per-book version + releasedAt +
 *                        minGezelVersion (versions are per book — the fleet
 *                        spans rebuilt lines and brand-new ids)
 *   books/<id>.json    — the TacticalBook: identity copy + doc block +
 *                        QualityWorkflow (see src/tactical-workflows.ts)
 *   evals/<id>.json    — the craftbook test spec shipped as test.json
 *
 * The expansion is qualityWorkflowSteps — the same compiler the gstack wave
 * uses — so every fleet book ships the reference quality-loop shape (gated
 * phases with requireChange, an enforceable evaluate, bounded repair,
 * needs-user escalation).
 *
 * Safety: append-only. A non-dry run preflights the whole wave and refuses
 * to write when ANY target version directory already exists — bump that
 * book's version + releasedAt in wave.json instead. Identity manifests are
 * merged (artwork, license, maintainer, yanks survive).
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  craftbookFromDoc,
  formatCraftbookDocErrors,
  parseCraftbookTestSpec,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { applyDefaultCraftbookStepPolicies } from '../src/craftbook-step-policy.js';
import {
  type TacticalBook,
  TacticalBookSchema,
  type TacticalWaveBook,
  TacticalWaveConfigSchema,
  mergeTacticalIdentity,
  tacticalCraftbookDoc,
} from '../src/tactical-workflows.js';
import { requireGildeCheckout } from './gilde-checkout.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTacticalBook(id: string, booksRoot: string): Promise<TacticalBook> {
  const path = join(booksRoot, `${id}.json`);
  try {
    return TacticalBookSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    throw new Error(
      `${id}: missing or invalid source ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function readTestSpecBytes(id: string, evalRoot: string): Promise<string> {
  const path = join(evalRoot, `${id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `${id}: missing or invalid eval source ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const parsed = parseCraftbookTestSpec(raw);
  if (!parsed.ok) {
    throw new Error(`${id}: invalid eval source ${path}:\n${parsed.errors.join('\n')}`);
  }
  return `${JSON.stringify(parsed.spec, null, 2)}\n`;
}

async function main(): Promise<void> {
  const gilde = requireGildeCheckout();
  const authoringRoot = join(gilde.root, 'authoring', 'tactical');
  const booksRoot = join(authoringRoot, 'books');
  const evalRoot = join(authoringRoot, 'evals');
  const dataRoot = join(gilde.dataDir, 'craftbook-templates');
  const dryRun = process.argv.includes('--dry-run');
  const onlyFlag = process.argv.indexOf('--only');
  const only =
    onlyFlag >= 0 && process.argv[onlyFlag + 1]
      ? new Set(process.argv[onlyFlag + 1]!.split(',').map((s: string) => s.trim()))
      : null;

  const wave = TacticalWaveConfigSchema.parse(
    JSON.parse(await readFile(join(authoringRoot, 'wave.json'), 'utf8')) as unknown,
  );
  const books = only ? wave.books.filter((b) => only.has(b.id)) : wave.books;
  if (books.length === 0) throw new Error('nothing to generate (check --only ids)');

  // Every book source in books/ must have a wave entry — an orphaned source
  // is a book someone authored and forgot to release.
  const waveIds = new Set(wave.books.map((b) => b.id));
  for (const file of await readdir(booksRoot).catch(() => [] as string[])) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!waveIds.has(id)) {
      throw new Error(`books/${file} has no wave.json entry — add its release mapping`);
    }
  }

  // Validate every source + eval before the first write.
  const compiled = new Map<string, { book: TacticalBook; release: TacticalWaveBook }>();
  const testBytes = new Map<string, string>();
  for (const release of books) {
    const book = await readTacticalBook(release.id, booksRoot);
    compiled.set(release.id, { book, release });
    testBytes.set(release.id, await readTestSpecBytes(release.id, evalRoot));
  }

  // Append-only preflight across the selection.
  if (!dryRun) {
    const collisions: string[] = [];
    for (const release of books) {
      const versionDir = join(
        dataRoot,
        release.id.slice(0, 2).toLowerCase(),
        release.id,
        'versions',
        release.version,
      );
      if (await pathExists(versionDir)) collisions.push(`${release.id}: ${versionDir}`);
    }
    if (collisions.length > 0) {
      throw new Error(
        `refusing to overwrite existing gilde versions:\n${collisions.map((line) => `  - ${line}`).join('\n')}\nBump the book's version + releasedAt in authoring/tactical/wave.json before regenerating.`,
      );
    }
  }

  let written = 0;
  for (const release of books) {
    const { book } = compiled.get(release.id)!;
    const doc = applyDefaultCraftbookStepPolicies(tacticalCraftbookDoc(book, release));
    const runtime = craftbookFromDoc(doc, { now: release.releasedAt });
    if (!runtime.ok) {
      throw new Error(
        `${release.id}: compiled doc failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
    }

    const shard = release.id.slice(0, 2).toLowerCase();
    const bookDir = join(dataRoot, shard, release.id);
    const versionDir = join(bookDir, 'versions', release.version);
    const manifestPath = join(bookDir, 'manifest.json');
    let existingIdentity: Record<string, unknown> = {};
    try {
      existingIdentity = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // First release of a new fleet id.
    }
    const identity = mergeTacticalIdentity(existingIdentity, book);

    if (dryRun) {
      console.log(`  ✓ ${release.id}@${release.version}: ${doc.steps.length} step(s) (dry run)`);
      continue;
    }
    await mkdir(versionDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(identity, null, 2)}\n`);
    await writeFile(join(versionDir, 'craftbook.json'), serializeCraftbookDoc(doc, 'json'));
    await writeFile(join(versionDir, 'test.json'), testBytes.get(release.id)!);
    written++;
    console.log(
      `  ✓ ${release.id}@${release.version}: ${doc.steps.length} step(s) → ${join(shard, release.id)}`,
    );
  }

  console.log(`\ndone: ${written} version(s) written${dryRun ? ' (dry run)' : ''}`);
  if (!dryRun && written > 0) {
    console.log('next: cd ../gilde && npm run fix && npm run check');
  }
}

await main();
