/**
 * Correct the four DocBlocks review releases whose ordinary PASS path was
 * accidentally changed to loop back into content authoring. This is an
 * append-only repair: the prior versions remain immutable and every local
 * eval sidecar is inherited unchanged.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CraftbookDocSchema,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { requireGildeCheckout } from './gilde-checkout.js';

const RELEASED_AT = '2026-09-27T03:00:00Z';

const REPAIRS = [
  { id: 'narrated-slideshow', sourceVersion: '1.1.5', targetVersion: '1.1.6' },
  { id: 'powerpoint-deck', sourceVersion: '1.7.14', targetVersion: '1.7.15' },
  { id: 'report-pdf', sourceVersion: '1.1.5', targetVersion: '1.1.6' },
  { id: 'research-to-document', sourceVersion: '1.2.5', targetVersion: '1.2.6' },
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { dataDir } = requireGildeCheckout();
  const plans: Array<{
    id: string;
    targetVersion: string;
    versionDir: string;
    craftbook: string;
    test: string;
  }> = [];

  for (const repair of REPAIRS) {
    const bookDir = join('craftbook-templates', repair.id.slice(0, 2), repair.id);
    const sourceDir = join(dataDir, bookDir, 'versions', repair.sourceVersion);
    const versionDir = join(dataDir, bookDir, 'versions', repair.targetVersion);
    if (await pathExists(versionDir)) {
      throw new Error(`${repair.id}: refusing to overwrite ${versionDir}`);
    }

    const raw = JSON.parse(await readFile(join(sourceDir, 'craftbook.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (raw.version !== repair.sourceVersion) {
      throw new Error(`${repair.id}: unexpected source version ${String(raw.version)}`);
    }

    const steps = raw.steps;
    if (!Array.isArray(steps)) throw new Error(`${repair.id}: steps are missing`);
    const evaluate = steps.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === 'object' && candidate !== null && candidate.id === 'evaluate',
    );
    if (!evaluate) throw new Error(`${repair.id}: evaluate step is missing`);
    if (evaluate.next !== 'write') {
      throw new Error(`${repair.id}: expected the regressed default to be write`);
    }
    if (!String(evaluate.prompt ?? '').includes('next: "finish"')) {
      throw new Error(`${repair.id}: evaluate lacks an explicit PASS-to-finish instruction`);
    }

    raw.version = repair.targetVersion;
    raw.releasedAt = RELEASED_AT;
    evaluate.next = 'finish';

    const doc = CraftbookDocSchema.parse(raw);
    const runtime = craftbookFromDoc(doc, { now: RELEASED_AT });
    if (!runtime.ok) {
      throw new Error(
        `${repair.id}: repaired document failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
    }

    plans.push({
      id: repair.id,
      targetVersion: repair.targetVersion,
      versionDir,
      craftbook: serializeCraftbookDoc(doc, 'json'),
      test: await readFile(join(sourceDir, 'test.json'), 'utf8'),
    });
  }

  for (const plan of plans) {
    console.log(`${dryRun ? 'would write' : 'writing'} ${plan.id}@${plan.targetVersion}`);
    if (dryRun) continue;
    await mkdir(plan.versionDir, { recursive: false });
    await writeFile(join(plan.versionDir, 'craftbook.json'), plan.craftbook);
    await writeFile(join(plan.versionDir, 'test.json'), plan.test);
  }
}

await main();
