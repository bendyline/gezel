/**
 * Publish append-only craftbook releases for the high-confidence parameter
 * contract defects found by the corpus audit.
 *
 * The migration is intentionally small and idempotent: it patches only the
 * named schema fields, copies the current test sidecar byte-for-byte, validates
 * the resulting document through core, and refuses to overwrite a version.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog repair-craftbook-params -- --dry-run
 *   pnpm --filter @bendyline/gezel-catalog repair-craftbook-params
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CraftbookDocSchema,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { requireGildeCheckout } from './gilde-checkout.js';

const RELEASED_AT = '2026-09-26T13:45:00Z';

type JsonObject = Record<string, unknown>;
type Repair = (doc: JsonObject) => void;

function properties(doc: JsonObject): Record<string, JsonObject> {
  const schema = doc.paramSchema as JsonObject | undefined;
  const value = schema?.properties;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${String(doc.id)}: expected paramSchema.properties`);
  }
  return value as Record<string, JsonObject>;
}

function setTitle(doc: JsonObject, key: string, title: string): void {
  const property = properties(doc)[key];
  if (!property) throw new Error(`${String(doc.id)}: missing parameter ${key}`);
  property.title = title;
}

const REPAIRS: Readonly<Record<string, Repair>> = {
  'draft-social-post': (doc) => {
    setTitle(doc, 'topic', 'Topic');
    setTitle(doc, 'platforms', 'Target platforms');
    setTitle(doc, 'campaign', 'Campaign');
  },
  'reception-report': (doc) => setTitle(doc, 'lookbackDays', 'Lookback days'),
  'social-digest': (doc) => setTitle(doc, 'lookbackHours', 'Lookback hours'),
  'translate-content': (doc) => setTitle(doc, 'language', 'Target language'),
  'code-review': (doc) => {
    const reviewId = properties(doc).reviewId;
    if (!reviewId) throw new Error('code-review: missing parameter reviewId');
    // The Review panel still pre-fills this value. Showing it also makes a
    // direct launch finishable instead of leaving {{reviewId}} in gate paths.
    reviewId.askUser = true;
    const schema = doc.paramSchema as JsonObject;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [];
    schema.required = [...new Set([...required, 'reviewId'])];
  },
};

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

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const root = join(requireGildeCheckout().dataDir, 'craftbook-templates');
  const planned: Array<{
    id: string;
    sourceVersion: string;
    targetVersion: string;
    targetDir: string;
    craftbook: string;
    test?: string;
  }> = [];

  for (const [id, repair] of Object.entries(REPAIRS)) {
    const bookDir = join(root, id.slice(0, 2), id);
    const versionsDir = join(bookDir, 'versions');
    const available = (await readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareSemver);
    const sourceVersion = available.at(-1);
    if (!sourceVersion) throw new Error(`${id}: no versioned craftbook found`);
    const targetVersion = bumpPatch(sourceVersion);
    const sourceDir = join(versionsDir, sourceVersion);
    const targetDir = join(versionsDir, targetVersion);
    if (await exists(targetDir)) throw new Error(`${id}: refusing to overwrite ${targetDir}`);

    const raw = JSON.parse(await readFile(join(sourceDir, 'craftbook.json'), 'utf8')) as JsonObject;
    repair(raw);
    raw.version = targetVersion;
    raw.releasedAt = RELEASED_AT;
    const parsed = CraftbookDocSchema.parse(raw);
    const runtime = craftbookFromDoc(parsed, { now: RELEASED_AT });
    if (!runtime.ok) {
      throw new Error(`${id}: repaired doc is invalid:\n${formatCraftbookDocErrors(runtime.errors)}`);
    }
    const testPath = join(sourceDir, 'test.json');
    planned.push({
      id,
      sourceVersion,
      targetVersion,
      targetDir,
      craftbook: serializeCraftbookDoc(parsed, 'json'),
      ...((await exists(testPath)) ? { test: await readFile(testPath, 'utf8') } : {}),
    });
  }

  console.log(`planned ${planned.length} immutable parameter-contract releases`);
  for (const entry of planned) {
    console.log(`  ${entry.id}: ${entry.sourceVersion} -> ${entry.targetVersion}`);
  }
  if (dryRun) return;

  for (const entry of planned) {
    await mkdir(entry.targetDir, { recursive: true });
    await writeFile(join(entry.targetDir, 'craftbook.json'), entry.craftbook);
    if (entry.test !== undefined) await writeFile(join(entry.targetDir, 'test.json'), entry.test);
  }
  console.log('next: cd ../gilde && npm run fix && npm run check');
}

await main();
