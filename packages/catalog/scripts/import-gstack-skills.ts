/**
 * Convert the committed skill snapshot into bundled craftbook-templates.
 *
 *   pnpm --filter @bendyline/gezel-catalog exec tsx scripts/import-gstack-skills.ts [--dry-run]
 *   pnpm --filter @bendyline/gezel-catalog run build-index
 *
 * Sources are the SNAPSHOT under `scripts/gstack-skills/<source>/SKILL.md`
 * (committed — regeneration must not depend on a live ../gstack
 * checkout), adapted from gstack (Garry Tan's stack —
 * github.com/garrytan/gstack). They ship as ordinary gezel skills:
 * plain, role-safe ids/names live in the `WAVE` config in
 * `../src/gstack-import.ts`; the user-facing source credit lives only in
 * each document's structured `basedOn` field.
 *
 * Hand-tuning lives in `scripts/gstack-overlays/<source>.json`, applied
 * AFTER conversion so edits survive re-runs by construction:
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
 * written to `gstack-personas/<source>.about.md` for hand review
 * (about.md diet rules apply before anything lands in gezel-templates).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import {
  type Overlay,
  RELEASED_AT,
  VERSION,
  WAVE,
  convertSnapshotSkill,
} from '../src/gstack-import.js';
import { requireGildeCheckout } from './gilde-checkout.js';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotRoot = join(here, 'gstack-skills');
const overlayRoot = join(here, 'gstack-overlays');
const personaRoot = join(here, 'gstack-personas');
const dataRoot = join(requireGildeCheckout().dataDir, 'craftbook-templates');

export async function readOverlay(source: string): Promise<Overlay> {
  try {
    return JSON.parse(await readFile(join(overlayRoot, `${source}.json`), 'utf8')) as Overlay;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  let written = 0;
  let skipped = 0;
  const personaDrafts: string[] = [];

  for (const book of WAVE) {
    const overlay = await readOverlay(book.source);
    if (overlay.frozen) {
      skipped++;
      console.log(`  ~ ${book.id}: frozen overlay — hand-owned, skipping regen`);
      continue;
    }

    const raw = await readFile(join(snapshotRoot, book.source, 'SKILL.md'), 'utf8');
    const converted = convertSnapshotSkill(book, raw, overlay);
    const { doc } = converted;

    // The same bar craftbook_write holds: the doc must expand into a
    // valid runtime craftbook or the build fails loudly.
    const runtime = craftbookFromDoc(doc, { now: RELEASED_AT });
    if (!runtime.ok) {
      throw new Error(
        `${book.id}: converted doc failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
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

    const shard = book.id.slice(0, 2).toLowerCase();
    const bookDir = join(dataRoot, shard, book.id);
    const identity = {
      schemaVersion: 1,
      kind: 'craftbook-template',
      id: book.id,
      name: book.name,
      description: firstSentence(doc.description ?? book.name),
      tags: book.tags,
      maintainer: { name: 'Gezel' },
      license: 'MIT',
      yankedVersions: [],
    };

    if (dryRun) {
      console.log(
        `  ✓ ${book.id}: ${doc.steps.length} step(s)${converted.notes.length ? ` — notes: ${converted.notes.join('; ')}` : ''}`,
      );
      continue;
    }
    await mkdir(join(bookDir, 'versions', VERSION), { recursive: true });
    await writeFile(join(bookDir, 'manifest.json'), `${JSON.stringify(identity, null, 2)}\n`);
    await writeFile(
      join(bookDir, 'versions', VERSION, 'craftbook.json'),
      serializeCraftbookDoc(doc, 'json'),
    );
    written++;
    console.log(`  ✓ ${book.id}: ${doc.steps.length} step(s) → ${join(shard, book.id)}`);
  }

  if (personaDrafts.length > 0) {
    console.log(`\npersona drafts (hand-review before shipping): ${personaDrafts.join(', ')}`);
  }
  console.log(`\ndone: ${written} written, ${skipped} frozen${dryRun ? ' (dry run)' : ''}`);
  if (!dryRun) {
    console.log('Next: pnpm --filter @bendyline/gezel-catalog run build-index');
  }
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const period = flat.indexOf('. ');
  const cut = period > 20 ? flat.slice(0, period + 1) : flat;
  return cut.length > 180 ? `${cut.slice(0, 177)}...` : cut;
}

// Import-safe: the regen test imports the helpers above without running
// the writer. Only execute when invoked as a script.
if (process.argv[1]?.endsWith('import-gstack-skills.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
