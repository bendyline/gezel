#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyEvalModelTier } from '../model-tier.ts';
import {
  type ComparisonPair,
  type ScoredTrial,
  canonicalModelId,
  compareScores,
  discoverScoredTrials,
} from './compare-scores.ts';

interface ModelManifest {
  architecture?: string;
  engine?: string;
  filename?: string;
  weightsFilename?: string;
}

export type CachedModelEngine = 'llama-cpp' | 'ds4';

export interface CachedModel {
  id: string;
  canonicalId: string;
  engine?: CachedModelEngine;
  roots: string[];
}

export interface ExcludedCachedModel {
  id: string;
  engine?: CachedModelEngine;
  roots: string[];
  reason: string;
}

export interface ModelCoverageRow {
  modelId: string;
  canonicalId: string;
  engine: CachedModelEngine;
  /** Capability tier (Theme E / E1-B) for the cached local-engine model. */
  modelTier: string;
  roots: string[];
  postTrialCount: number;
  postScenarioCount: number;
  comparablePairCount: number;
  passingComparablePairCount: number;
  latestPostComposite: number | null;
  scenariosPostCutoff: string[];
}

export interface ModelCoverage {
  cutoffIso: string;
  cachedModels: CachedModel[];
  excludedCachedModels: ExcludedCachedModel[];
  scoredTrialCount: number;
  rows: ModelCoverageRow[];
}

function listDirs(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    try {
      return statSync(join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function fmtScore(value: number | null): string {
  return value === null ? '-' : value.toFixed(1);
}

function modelIdsMatchExactlyOrHistoricalAlias(
  trialModelId: string,
  cachedModelId: string,
): boolean {
  if (trialModelId === cachedModelId) return true;
  // Older eval-cache runs used bare IDs for what are now explicit q4 catalog
  // IDs. Keep these bridges narrow so q4 evidence never counts for q8.
  const historicalPostAliases: Record<string, string[]> = {
    'mistral-7b-q4': ['mistral'],
    'nemotron3-nano-30b-q4': ['nemotron3-nano-30b'],
    'nemotron3-super-120b-q4': ['nemotron3-super-120b'],
  };
  return historicalPostAliases[cachedModelId]?.includes(trialModelId) ?? false;
}

const unsupportedLlamaCppArchitectures = new Set([
  // The current bundled llama.cpp build logs "unknown model architecture:
  // 'deepseek4'" for these GGUFs before serving requests.
  'deepseek4',
]);

function engineForRoot(root: string, manifest: ModelManifest): CachedModelEngine {
  if (manifest.engine === 'ds4') return 'ds4';
  const normalized = root.replaceAll('\\', '/');
  return normalized.includes('/engines/ds4/models') ? 'ds4' : 'llama-cpp';
}

function unsupportedRuntimeReason(
  manifest: ModelManifest,
  engine: CachedModelEngine,
): string | null {
  // DeepSeek-V4 is intentionally hosted by the dedicated ds4 engine. Only
  // classify its legacy llama.cpp cache entry as unsupported; a complete ds4
  // install is usable and must remain in the coverage denominator.
  if (engine !== 'llama-cpp') return null;
  if (!manifest.architecture) return null;
  if (!unsupportedLlamaCppArchitectures.has(manifest.architecture)) return null;
  return `unsupported by current llama.cpp binary: architecture ${manifest.architecture}`;
}

export function defaultModelRoots(): string[] {
  const home = homedir();
  return [
    join(home, '.gezel-eval-cache/engines/llama-cpp/models'),
    join(home, '.gezel-dev/engines/llama-cpp/models'),
    join(home, '.gezel-eval-cache/engines/ds4/models'),
    join(home, '.gezel-dev/engines/ds4/models'),
  ];
}

export function discoverCachedModelInventory(modelRoots: string[]): {
  cachedModels: CachedModel[];
  excludedCachedModels: ExcludedCachedModel[];
} {
  const byId = new Map<string, CachedModel>();
  const excludedById = new Map<string, ExcludedCachedModel>();
  for (const root of modelRoots) {
    const absRoot = resolve(root);
    for (const id of listDirs(absRoot)) {
      const modelDir = join(absRoot, id);
      const manifest = readJson<ModelManifest>(join(modelDir, 'manifest.json'));
      if (!manifest) continue;
      const weightsFilename = manifest.weightsFilename ?? manifest.filename;
      if (!weightsFilename) continue;
      if (!existsSync(join(modelDir, weightsFilename))) continue;
      const engine = engineForRoot(absRoot, manifest);
      const key = `${engine}\u0000${id}`;
      const unsupportedReason = unsupportedRuntimeReason(manifest, engine);
      if (unsupportedReason) {
        const existingExcluded = excludedById.get(key);
        if (existingExcluded) {
          existingExcluded.roots.push(absRoot);
        } else {
          excludedById.set(key, {
            id,
            engine,
            roots: [absRoot],
            reason: unsupportedReason,
          });
        }
        continue;
      }
      const existing = byId.get(key);
      if (existing) {
        existing.roots.push(absRoot);
      } else {
        byId.set(key, {
          id,
          canonicalId: canonicalModelId(id),
          engine,
          roots: [absRoot],
        });
      }
    }
  }
  return {
    cachedModels: [...byId.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || (a.engine ?? '').localeCompare(b.engine ?? ''),
    ),
    excludedCachedModels: [...excludedById.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || (a.engine ?? '').localeCompare(b.engine ?? ''),
    ),
  };
}

export function discoverCachedModels(modelRoots: string[]): CachedModel[] {
  return discoverCachedModelInventory(modelRoots).cachedModels;
}

function latestPostComposite(trials: ScoredTrial[]): number | null {
  const latest = trials.reduce<ScoredTrial | null>((acc, trial) => {
    if (!acc) return trial;
    return Date.parse(trial.startedAt) > Date.parse(acc.startedAt) ? trial : acc;
  }, null);
  return latest?.composite ?? null;
}

export function buildModelCoverage(opts: {
  cachedModels: CachedModel[];
  trials: ScoredTrial[];
  cutoffIso: string;
  pairs?: ComparisonPair[];
  excludedCachedModels?: ExcludedCachedModel[];
}): ModelCoverage {
  const cutoffMs = Date.parse(opts.cutoffIso);
  if (!Number.isFinite(cutoffMs)) throw new Error(`invalid cutoff: ${opts.cutoffIso}`);
  const pairs = opts.pairs ?? compareScores(opts.trials, opts.cutoffIso).comparablePairs;
  const rows = opts.cachedModels.map((model): ModelCoverageRow => {
    const engine = model.engine ?? 'llama-cpp';
    const postTrials = opts.trials.filter(
      (trial) =>
        modelIdsMatchExactlyOrHistoricalAlias(trial.modelId, model.id) &&
        Date.parse(trial.startedAt) >= cutoffMs,
    );
    const modelPairs = pairs.filter(
      (pair) =>
        pair.key.startsWith(`${model.canonicalId}\u0000`) &&
        modelIdsMatchExactlyOrHistoricalAlias(pair.post.modelId, model.id),
    );
    return {
      modelId: model.id,
      canonicalId: model.canonicalId,
      engine,
      modelTier: classifyEvalModelTier({ engine, modelId: model.id }),
      roots: model.roots,
      postTrialCount: postTrials.length,
      postScenarioCount: new Set(postTrials.map((trial) => trial.scenarioId)).size,
      comparablePairCount: modelPairs.length,
      passingComparablePairCount: modelPairs.filter((pair) => pair.post.composite >= 8).length,
      latestPostComposite: latestPostComposite(postTrials),
      scenariosPostCutoff: uniqueSorted(postTrials.map((trial) => trial.scenarioId)),
    };
  });

  rows.sort(
    (a, b) =>
      b.comparablePairCount - a.comparablePairCount ||
      b.postTrialCount - a.postTrialCount ||
      a.modelId.localeCompare(b.modelId) ||
      a.engine.localeCompare(b.engine),
  );

  return {
    cutoffIso: opts.cutoffIso,
    cachedModels: opts.cachedModels,
    excludedCachedModels: opts.excludedCachedModels ?? [],
    scoredTrialCount: opts.trials.length,
    rows,
  };
}

export function renderModelCoverageReport(coverage: ModelCoverage): string {
  const covered = coverage.rows.filter((row) => row.postTrialCount > 0).length;
  const comparable = coverage.rows.filter((row) => row.comparablePairCount > 0).length;
  const lines = [
    `# Downloaded model eval coverage - ${coverage.cutoffIso.slice(0, 10)}`,
    '',
    `Source: ${coverage.cachedModels.length} usable cached local-engine installs and ${coverage.scoredTrialCount} scored trial directories.`,
    '',
    '## Aggregate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Usable cached model installs | ${coverage.cachedModels.length} |`,
    `| Models with post-cutoff scored trials | ${covered} / ${coverage.cachedModels.length} |`,
    `| Models with comparable pre/post pairs | ${comparable} / ${coverage.cachedModels.length} |`,
    '',
    '## Models',
    '',
    '| Cached model | Engine | Tier | Canonical key | Post trials | Post scenarios | Comparable pairs | Latest post score | Scenarios post-cutoff |',
    '|---|---|---|---|---:|---:|---:|---:|---|',
  ];

  for (const row of coverage.rows) {
    const scenarios = row.scenariosPostCutoff.length > 0 ? row.scenariosPostCutoff.join(', ') : '-';
    lines.push(
      `| ${row.modelId} | ${row.engine} | ${row.modelTier} | ${row.canonicalId} | ${row.postTrialCount} | ${row.postScenarioCount} | ${row.comparablePairCount} | ${fmtScore(row.latestPostComposite)} | ${scenarios} |`,
    );
  }

  lines.push(
    '',
    '## Notes',
    '',
    '- A post-cutoff scored trial means a trial at or after the cutoff has a scored trial `postmortem.md` plus sibling `facts.json` or `result.json` metadata.',
    '- A comparable pair means the same canonical model and scenario has both pre-cutoff and post-cutoff scored trials.',
    '- Cache directories with unreadable manifests or missing weight files are excluded from the denominator.',
    '- Cache directories with readable weights but unsupported model architectures are excluded from the usable denominator and listed below.',
    '- This report intentionally includes cached models with no post-cutoff evidence so the remaining matrix gap is visible.',
    '- All columns are raw counts, never rates. For `tiny`-tier models especially, read counts as counts — at a ~50% base rate a per-scenario pass fraction is a coin flip, not a measurement.',
    '',
  );
  if (coverage.excludedCachedModels.length > 0) {
    lines.push(
      '## Excluded cached models',
      '',
      '| Cached model | Engine | Reason |',
      '|---|---|---|',
    );
    for (const model of coverage.excludedCachedModels) {
      lines.push(`| ${model.id} | ${model.engine ?? 'llama-cpp'} | ${model.reason} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  let cutoffIso = '2026-06-05T00:00:00Z';
  let runsDir = existsSync('runs') ? 'runs' : 'evals/runs';
  let outPath: string | undefined;
  const modelRoots: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--cutoff') {
      cutoffIso = args[++i] ?? '';
    } else if (arg === '--runs') {
      runsDir = args[++i] ?? '';
    } else if (arg === '--out') {
      outPath = args[++i] ?? '';
    } else if (arg === '--model-root') {
      modelRoots.push(args[++i] ?? '');
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: model-coverage.ts [--cutoff ISO] [--runs DIR] [--out FILE] [--model-root DIR ...]\n',
      );
      return;
    }
  }

  const roots = modelRoots.length > 0 ? modelRoots : defaultModelRoots();
  const trials = discoverScoredTrials(runsDir);
  const inventory = discoverCachedModelInventory(roots);
  const coverage = buildModelCoverage({
    cachedModels: inventory.cachedModels,
    excludedCachedModels: inventory.excludedCachedModels,
    trials,
    cutoffIso,
  });
  const report = renderModelCoverageReport(coverage);
  process.stdout.write(report);
  if (outPath) {
    writeFileSync(outPath, report.endsWith('\n') ? report : `${report}\n`);
    process.stderr.write(`\n[model-coverage] wrote ${outPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
