/**
 * Publish one append-only policy release for every current Gilde craftbook
 * whose steps do not explicitly declare all inferred output media.
 *
 * The migration copies the newest immutable version, adds deterministic
 * per-step `toolPolicy` JSON (including fanout steps), bumps only the patch
 * version, and carries the latest test sidecar forward unchanged.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog migrate-step-policies -- --dry-run
 *   pnpm --filter @bendyline/gezel-catalog migrate-step-policies
 *   pnpm --filter @bendyline/gezel-catalog migrate-step-policies -- --only=powerpoint-deck
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CraftbookDocSchema,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import {
  applyDefaultCraftbookStepPolicies,
  outputMediaForCraftbookBlueprint,
} from '../src/craftbook-step-policy.js';
import { requireGildeCheckout } from './gilde-checkout.js';

const RELEASED_AT = '2026-09-05T03:30:00Z';

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function bumpPatch(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`cannot bump non-semver craftbook version ${version}`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function bookDirectories(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(root, shard.name);
    for (const book of await readdir(shardDir, { withFileTypes: true })) {
      if (book.isDirectory() && (await exists(join(shardDir, book.name, 'manifest.json')))) {
        out.push(join(shardDir, book.name));
      }
    }
  }
  return out.sort();
}

async function versions(bookDir: string): Promise<string[]> {
  const dir = join(bookDir, 'versions');
  if (!(await exists(dir))) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareSemver);
}

function allStepsDeclareRequiredOutputMedia(
  doc: ReturnType<typeof CraftbookDocSchema.parse>,
): boolean {
  const steps = [...doc.steps, ...(doc.spawn?.steps ?? [])];
  return steps.every((step) => {
    if (step.toolPolicy?.outputMedium === undefined) return false;
    const declared = new Set([
      ...(step.toolPolicy.outputMedium === 'none' ? [] : [step.toolPolicy.outputMedium]),
      ...(step.toolPolicy.additionalOutputMedia ?? []),
    ]);
    return [...outputMediaForCraftbookBlueprint(step)].every((medium) => declared.has(medium));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const onlyArg = args.find((arg) => arg.startsWith('--only='));
  const only = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      )
    : null;
  const root = join(requireGildeCheckout().dataDir, 'craftbook-templates');
  const books = await bookDirectories(root);
  const planned: Array<{
    id: string;
    sourceVersion: string;
    targetVersion: string;
    sourceDir: string;
    targetDir: string;
    bytes: string;
    testBytes?: string;
    media: Record<string, number>;
    deniedGroups: number;
    deniedToolsets: number;
  }> = [];

  for (const bookDir of books) {
    const id = bookDir.split(/[\\/]/).at(-1)!;
    if (only && !only.has(id)) continue;
    const available = await versions(bookDir);
    if (available.length === 0) continue;
    const identity = JSON.parse(await readFile(join(bookDir, 'manifest.json'), 'utf8')) as {
      yankedVersions?: string[];
    };
    const yanked = new Set(identity.yankedVersions ?? []);
    // A tombstoned identity has no active version. Publishing a new policy
    // release would accidentally resurrect it into the catalog.
    if (available.every((version) => yanked.has(version))) continue;
    const sourceVersion = available.at(-1)!;
    const sourceDir = join(bookDir, 'versions', sourceVersion);
    const parsed = CraftbookDocSchema.parse(
      JSON.parse(await readFile(join(sourceDir, 'craftbook.json'), 'utf8')) as unknown,
    );
    if (allStepsDeclareRequiredOutputMedia(parsed)) continue;

    const targetVersion = bumpPatch(sourceVersion);
    const targetDir = join(bookDir, 'versions', targetVersion);
    if (await exists(targetDir)) {
      throw new Error(`${id}: refusing to overwrite existing ${targetDir}`);
    }
    const migrated = applyDefaultCraftbookStepPolicies({
      ...parsed,
      version: targetVersion,
      releasedAt: RELEASED_AT,
    });
    const runtime = craftbookFromDoc(migrated, { now: RELEASED_AT });
    if (!runtime.ok) {
      throw new Error(
        `${id}: migrated doc failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
    }
    const media: Record<string, number> = {};
    let deniedGroups = 0;
    let deniedToolsets = 0;
    for (const step of [...migrated.steps, ...(migrated.spawn?.steps ?? [])]) {
      const medium = step.toolPolicy!.outputMedium!;
      media[medium] = (media[medium] ?? 0) + 1;
      deniedGroups += step.toolPolicy?.disallowBuiltinToolsets?.length ?? 0;
      deniedToolsets += step.toolPolicy?.disallowToolsets?.length ?? 0;
    }
    const sourceTest = join(sourceDir, 'test.json');
    planned.push({
      id,
      sourceVersion,
      targetVersion,
      sourceDir,
      targetDir,
      bytes: serializeCraftbookDoc(migrated, 'json'),
      ...((await exists(sourceTest)) ? { testBytes: await readFile(sourceTest, 'utf8') } : {}),
      media,
      deniedGroups,
      deniedToolsets,
    });
    if (verbose) {
      console.log(
        JSON.stringify(
          {
            id,
            steps: [...migrated.steps, ...(migrated.spawn?.steps ?? [])].map((step) => ({
              id: step.id,
              role: step.suggestedRole,
              toolPolicy: step.toolPolicy,
            })),
          },
          null,
          2,
        ),
      );
    }
  }

  if (only) {
    const found = new Set(planned.map((entry) => entry.id));
    const missing = [...only].filter((id) => !found.has(id));
    if (missing.length > 0) {
      console.warn(`unchanged or missing ids: ${missing.join(', ')}`);
    }
  }

  const totals: Record<string, number> = {};
  let groups = 0;
  let toolsets = 0;
  for (const entry of planned) {
    for (const [medium, count] of Object.entries(entry.media)) {
      totals[medium] = (totals[medium] ?? 0) + count;
    }
    groups += entry.deniedGroups;
    toolsets += entry.deniedToolsets;
  }
  console.log(
    `planned ${planned.length} immutable craftbook releases; output media ${JSON.stringify(totals)}; ${groups} built-in group denials; ${toolsets} exact toolset denials`,
  );
  if (dryRun) {
    for (const entry of planned) {
      console.log(`  ${entry.id}: ${entry.sourceVersion} -> ${entry.targetVersion}`);
    }
    return;
  }

  for (const entry of planned) {
    await mkdir(entry.targetDir, { recursive: true });
    await writeFile(join(entry.targetDir, 'craftbook.json'), entry.bytes);
    if (entry.testBytes !== undefined) {
      await writeFile(join(entry.targetDir, 'test.json'), entry.testBytes);
    }
    console.log(`  ✓ ${entry.id}: ${entry.sourceVersion} -> ${entry.targetVersion}`);
  }
  console.log('next: cd ../gilde && npm run fix && npm run check');
}

await main();
