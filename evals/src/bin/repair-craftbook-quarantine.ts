#!/usr/bin/env node
/**
 * Publish append-only Gilde releases that turn every currently quarantined
 * craftbook sidecar into a real offline workflow-processability evaluation.
 *
 * Targets come from the same reachability + boilerplate detectors as
 * `craftbook:plan`; no hand-maintained quarantine list can drift from CI.
 * The command preflights every release before its first write and refuses to
 * overwrite an immutable version directory.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-evals craftbook:repair-quarantine -- --dry-run
 *   pnpm --filter @bendyline/gezel-evals craftbook:repair-quarantine
 */

import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CraftbookDocSchema,
  parseCraftbookTestSpec,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { findBoilerplateEvalSpecs } from '../craftbooks/boilerplate.ts';
import { loadCraftbookTemplates } from '../craftbooks/catalog.ts';
import { auditDeliverableReachability } from '../craftbooks/deliverable-reachability.ts';
import { rebuildWorkflowTestSpec } from '../craftbooks/rebuild-workflow-spec.ts';
import { CRAFTBOOK_EVAL_SPECS } from '../craftbooks/specs.ts';
import { loadCraftbookTestSpecsSync } from '../craftbooks/test-spec-loader.ts';

const DEFAULT_RELEASED_AT = '2026-09-26T18:30:00Z';
const MAX_TEST_BYTES = 128 * 1024;

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
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

function selectedIds(all: Set<string>): Set<string> {
  const only = flagValue('--only');
  if (!only) return all;
  const requested = new Set(
    only
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const unknown = [...requested].filter((id) => !all.has(id));
  if (unknown.length > 0) {
    throw new Error(`--only contains non-quarantined craftbook id(s): ${unknown.join(', ')}`);
  }
  return requested;
}

interface ReleasePlan {
  id: string;
  sourceVersion: string;
  targetVersion: string;
  targetDir: string;
  craftbookJson: string;
  testJson: string;
  outputPaths: string[];
}

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const releasedAt = flagValue('--released-at') ?? DEFAULT_RELEASED_AT;
  if (Number.isNaN(Date.parse(releasedAt))) throw new Error(`invalid --released-at: ${releasedAt}`);

  const templates = await loadCraftbookTemplates();
  const reachability = auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates);
  const boilerplate = findBoilerplateEvalSpecs(CRAFTBOOK_EVAL_SPECS);
  const quarantined = new Set([
    ...reachability.findings.map((finding) => finding.craftbookId),
    ...boilerplate.map((finding) => finding.craftbookId),
  ]);
  const targets = selectedIds(quarantined);
  const loadedById = new Map(
    loadCraftbookTestSpecsSync().map((loaded) => [loaded.craftbookId, loaded]),
  );
  const dataRoot = await realpath(gildeDataDir());
  const templateRoot = join(dataRoot, 'craftbook-templates');
  const plans: ReleasePlan[] = [];
  const unresolved: string[] = [];

  for (const id of [...targets].sort()) {
    const loaded = loadedById.get(id);
    if (!loaded) throw new Error(`${id}: active test sidecar was not loaded`);
    const sourceDir = join(templateRoot, id.slice(0, 2), id, 'versions', loaded.version);
    const targetVersion = bumpPatch(loaded.version);
    const targetDir = join(templateRoot, id.slice(0, 2), id, 'versions', targetVersion);
    if (await exists(targetDir)) {
      throw new Error(`${id}: refusing to overwrite immutable release ${targetVersion}`);
    }

    const rawDoc = JSON.parse(await readFile(join(sourceDir, 'craftbook.json'), 'utf8')) as unknown;
    const sourceDoc = CraftbookDocSchema.parse(rawDoc);
    const sourceTestRaw = JSON.parse(
      await readFile(join(sourceDir, 'test.json'), 'utf8'),
    ) as unknown;
    const parsedTest = parseCraftbookTestSpec(sourceTestRaw, { mode: 'strict' });
    if (!parsedTest.ok) {
      throw new Error(
        `${id}@${loaded.version}: invalid source test: ${parsedTest.errors.join('; ')}`,
      );
    }

    const rebuilt = rebuildWorkflowTestSpec(sourceDoc, parsedTest.spec);
    for (const output of rebuilt.outputs) {
      if (/\{\{(?!\s*task\.(?:dir|num)\s*\}\})/.test(output.path)) {
        unresolved.push(`${id}: ${output.path}`);
      }
    }
    const checkedTest = parseCraftbookTestSpec(rebuilt.spec, { mode: 'strict' });
    if (!checkedTest.ok) {
      throw new Error(`${id}: rebuilt test is invalid: ${checkedTest.errors.join('; ')}`);
    }
    const testJson = `${JSON.stringify(checkedTest.spec, null, 2)}\n`;
    if (Buffer.byteLength(testJson) > MAX_TEST_BYTES) {
      throw new Error(`${id}: rebuilt test exceeds ${MAX_TEST_BYTES} bytes`);
    }
    const targetDoc = CraftbookDocSchema.parse({
      ...sourceDoc,
      version: targetVersion,
      releasedAt,
    });
    plans.push({
      id,
      sourceVersion: loaded.version,
      targetVersion,
      targetDir,
      craftbookJson: serializeCraftbookDoc(targetDoc, 'json'),
      testJson,
      outputPaths: rebuilt.outputs.map((output) => output.path),
    });
  }

  if (unresolved.length > 0) {
    throw new Error(`unresolved output parameter token(s):\n${unresolved.join('\n')}`);
  }
  console.log(
    `quarantine: ${quarantined.size} unique (${reachability.findings.length} reachability, ${boilerplate.length} boilerplate); selected ${plans.length}`,
  );
  const withoutStaticOutputs = plans.filter((plan) => plan.outputPaths.length === 0);
  console.log(
    `preflight: ${plans.length - withoutStaticOutputs.length} with declared outputs, ${withoutStaticOutputs.length} generic/hook workflows`,
  );
  for (const plan of plans) {
    console.log(
      `  ${plan.id}: ${plan.sourceVersion} -> ${plan.targetVersion} (${plan.outputPaths.length} declared output${plan.outputPaths.length === 1 ? '' : 's'})`,
    );
  }
  if (dryRun) return;

  // Full-corpus preflight above is deliberate: no partial release wave if a
  // late book is malformed or already has the target immutable version.
  for (const plan of plans) {
    await mkdir(plan.targetDir, { recursive: true });
    await writeFile(join(plan.targetDir, 'craftbook.json'), plan.craftbookJson);
    await writeFile(join(plan.targetDir, 'test.json'), plan.testJson);
  }
  console.log(`wrote ${plans.length} append-only releases; rebuild the Gilde index next`);
}

await main();
