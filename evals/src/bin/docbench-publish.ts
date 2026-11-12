/**
 * `pnpm eval:docbench-publish --run-id <id>` — publish a finished docbench
 * round.
 *
 * Writes two things, and refuses both unless the round is publishable
 * (complete, fully judged by the official judge, which passed its validity
 * study):
 *
 *  1. The scorecard shard `packages/core/src/scorecard/data/runs/<run>.json`
 *     (suite `docbench`), and the regenerated shard barrel — what the
 *     handboek's docbench table and model pages render.
 *  2. `benchmarks.docbench[<engine>]` into each measured model's Gilde
 *     authoring recipe and identity manifest in the sibling gilde checkout
 *     (`--gilde <dir>`, default `../gilde`) — what `/v1/models` and the
 *     recommender read once Gilde is rebuilt and released.
 *
 * `--dry-run` prints what would change and writes nothing. `--skip-gilde`
 * writes only the scorecard shard.
 *
 * `--models a,b --against <published-run-id>` publishes a focused re-run:
 * only those models, as a `subset` round beside the published one (which
 * stays the headline), banded within its field. It refuses a re-run that
 * changed the judge, fixtures, prompt date, launch context, machine or pack
 * line, since then the two rounds would not compare.
 *
 * Nothing here touches git: review and commit the changes in both repos.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema, shardFileName } from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { BenchPackManifestSchema } from '@bendyline/gezel/eval';
import {
  type PublishModelFacts,
  docbenchPublication,
  docbenchScorecardRunId,
  withDocbenchBenchmark,
} from '../docbench/publish.ts';
import type { DocbenchSummary } from '../docbench/report.ts';
import { classifyEvalModelTier } from '../model-tier.ts';
import { resolvedGildeVersion } from '../scorecard.ts';
import { parseArgs } from './args.ts';

const KNOWN_FLAGS = new Set([
  'run-id',
  'gilde',
  'engine',
  'dry-run',
  'skip-gilde',
  'models',
  'against',
]);

const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(evalsRoot, '..');
const shardDir = join(repoRoot, 'packages/core/src/scorecard/data/runs');

function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface IndexedManifest {
  id?: string;
  name?: string;
  version?: string;
  parameterSize?: string;
  llamaCpp?: { quantization?: string };
  mlx?: { quantization?: string };
}

/** Catalog facts per model, from the Gilde data the round was measured against. */
function catalogFacts(engine: string): (modelId: string) => PublishModelFacts | undefined {
  const index = readJson<{ entries?: Array<{ manifest?: IndexedManifest }> }>(
    join(gildeDataDir(), 'chat-models', 'index.json'),
  );
  const byId = new Map<string, IndexedManifest>();
  for (const entry of index.entries ?? []) {
    if (entry.manifest?.id) byId.set(entry.manifest.id, entry.manifest);
  }
  return (modelId) => {
    const manifest = byId.get(modelId);
    if (!manifest?.name) return undefined;
    const quantization = (engine === 'mlx' ? manifest.mlx : manifest.llamaCpp)?.quantization;
    return {
      label: manifest.name,
      tier: classifyEvalModelTier({ engine: 'llama-cpp', modelId }),
      ...(manifest.parameterSize ? { parameterSize: manifest.parameterSize } : {}),
      ...(quantization ? { quantization } : {}),
      ...(manifest.version ? { catalogVersion: manifest.version } : {}),
    };
  };
}

function runNode(script: string, args: string[]): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const detail = (result.stderr || result.stdout || '').trim();
  // biome.json ignores `runs/**`, which matches the shard directory too; a
  // format pass that processes nothing is not a failure.
  if (result.status !== 0 && !/No files were processed/iu.test(detail)) {
    throw new Error(`${script} failed${detail ? `:\n${detail}` : ''}`);
  }
}

/** A Gilde file, read and rewritten with the benchmark set; null when absent. */
function updateGildeFile(
  path: string,
  engine: string,
  score: Parameters<typeof withDocbenchBenchmark>[2],
  dryRun: boolean,
): boolean {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  const next = `${JSON.stringify(withDocbenchBenchmark(JSON.parse(raw), engine, score), null, 2)}\n`;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  if (!dryRun) writeFileSync(path, next.replace(/\n/gu, eol));
  return true;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const unknown = Object.keys(flags).filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown flag: --${unknown.join(', --')}`);
  const runId = text(flags['run-id']);
  if (!runId) throw new Error('--run-id is required');
  const engine = text(flags.engine) ?? 'llama-cpp';
  const dryRun = flags['dry-run'] === true;
  const runDir = join(evalsRoot, 'runs', `docbench-${runId}`);
  const summaryFile = join(runDir, 'summary.json');
  if (!existsSync(summaryFile)) {
    throw new Error(`No summary at ${summaryFile}; score the round with pnpm eval:docbench first`);
  }
  const summary = readJson<DocbenchSummary>(summaryFile);
  const manifest = BenchPackManifestSchema.parse(readJson(join(runDir, 'manifest.json')));
  const rerunModels = text(flags.models)
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const againstId = text(flags.against);
  if (Boolean(rerunModels) !== Boolean(againstId)) {
    throw new Error('--models and --against go together: a focused re-run names both');
  }
  const againstFile = againstId
    ? join(evalsRoot, 'runs', `docbench-${againstId}`, 'summary.json')
    : null;
  if (againstFile && !existsSync(againstFile)) throw new Error(`No summary at ${againstFile}`);
  const rerun =
    rerunModels && againstFile
      ? { models: rerunModels, against: readJson<DocbenchSummary>(againstFile) }
      : undefined;

  const publication = docbenchPublication({
    summary,
    manifest,
    engine,
    gildeVersion: resolvedGildeVersion(repoRoot),
    facts: catalogFacts(engine),
    ...(rerun ? { rerun } : {}),
  });
  ScorecardDatasetSchema.parse(publication.shard);
  for (const warning of publication.warnings) console.warn(`[docbench-publish] ${warning}`);

  const shardPath = join(shardDir, shardFileName(docbenchScorecardRunId(summary)));
  console.log(
    `[docbench-publish] ${dryRun ? 'would write' : 'writing'} ${shardPath} (${String(publication.shard.results.length)} models)`,
  );
  if (!dryRun) {
    writeFileSync(shardPath, `${JSON.stringify(publication.shard, null, 2)}\n`);
    runNode(createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome'), [
      'format',
      '--write',
      '--config-path',
      repoRoot,
      shardPath,
    ]);
    runNode(join(repoRoot, 'scripts/gen-scorecard-barrel.mjs'), []);
  }

  if (flags['skip-gilde'] === true) return;
  const gilde = resolve(text(flags.gilde) ?? join(repoRoot, '..', 'gilde'));
  if (!existsSync(join(gilde, 'authoring', 'chat-models'))) {
    throw new Error(`No Gilde checkout at ${gilde} (pass --gilde <dir>, or --skip-gilde)`);
  }
  const missing: string[] = [];
  for (const [modelId, score] of publication.benchmarks) {
    const recipe = join(gilde, 'authoring', 'chat-models', `${modelId}.json`);
    const identity = join(
      gilde,
      'data',
      'chat-models',
      modelId.slice(0, 2),
      modelId,
      'manifest.json',
    );
    const wroteRecipe = updateGildeFile(recipe, engine, score, dryRun);
    const wroteIdentity = updateGildeFile(identity, engine, score, dryRun);
    if (!wroteRecipe || !wroteIdentity) missing.push(modelId);
    console.log(
      `[docbench-publish] ${modelId}: docbench ${String(score.score)} (band ${String(score.band)}, catalog ${score.catalogVersion})`,
    );
  }
  if (missing.length > 0) {
    throw new Error(`No Gilde recipe or identity manifest for ${missing.join(', ')}`);
  }
  console.log(
    `[docbench-publish] ${dryRun ? 'dry run: nothing written' : 'done'}. Next: rebuild and check Gilde (npm run check in ${gilde}), release it, and bump the gezel pin so /v1/models serves the scores.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
