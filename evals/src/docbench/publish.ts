/**
 * Publishing a docbench round: the scorecard shard the handboek renders, and
 * the `benchmarks.docbench` block Gilde ships so the recommender can rank by
 * it. Pure functions over a round's `summary.json`; the bin does the IO.
 *
 * Only a publishable round goes out — complete, every case judged, by the
 * official judge, which passed its validity tests. Everything else is a
 * diagnostic, and the refusal says which condition failed.
 */

import {
  DOCBENCH_SUITE_ID,
  type DocbenchCatalogScore,
  SCORECARD_SCHEMA_VERSION,
  type ScorecardDataset,
  type ScorecardDocbench,
  type ScorecardModelResult,
  type ScorecardRun,
} from '@bendyline/gezel';
import type { BenchPackManifest } from '@bendyline/gezel/eval';
import type { DocbenchSummary, ModelSummary } from './report.ts';
import { type Interval, assignBands } from './score.ts';

/** What the catalog says about a measured build. */
export interface PublishModelFacts {
  readonly label: string;
  readonly tier: string;
  readonly parameterSize?: string;
  readonly quantization?: string;
  /** The catalog's version now; used only when generation did not record one. */
  readonly catalogVersion?: string;
}

export interface DocbenchPublishInput {
  readonly summary: DocbenchSummary;
  readonly manifest: BenchPackManifest;
  /** The engine every model ran on; v1 rounds are llama.cpp only. */
  readonly engine: string;
  readonly gildeVersion: string;
  readonly facts: (modelId: string) => PublishModelFacts | undefined;
  /**
   * Publish only these models, as a focused re-run of an already published
   * round (`against`) — after a fix that changed what they could do. The run
   * is scoped `subset`, so it never becomes the headline table, and each
   * model's band is its place in the published field with its old result
   * replaced by this one: a band from a two-model round would rank nothing.
   */
  readonly rerun?: { readonly models: readonly string[]; readonly against: DocbenchSummary };
}

export interface DocbenchPublication {
  readonly shard: ScorecardDataset;
  /** Per model: the entry for `benchmarks.docbench[engine]`. */
  readonly benchmarks: ReadonlyMap<string, DocbenchCatalogScore>;
  readonly warnings: readonly string[];
}

/** Why a round may not be published, or an empty list when it may. */
export function publishRefusals(summary: DocbenchSummary): string[] {
  const reasons: string[] = [];
  if (!summary.judge) reasons.push('the round was not judged');
  else if (!summary.judge.official) {
    reasons.push(`the judge (${summary.judge.model}) is not the official judge`);
  }
  if (!summary.validity) {
    reasons.push('no judge validity study for this judge and prompt version');
  } else if (!summary.validity.pass) reasons.push('the judge failed its validity study');
  if (!summary.pack.fixtures) reasons.push('the round does not record its fixture set');
  if (summary.models.length === 0) reasons.push('the round scored no models');
  for (const model of summary.models) {
    if (model.coverage < 0.999) {
      reasons.push(`${model.modelId} is missing ${model.missingFamilies.join(', ')}`);
    }
    if (model.judgedShare < 0.999) {
      reasons.push(
        `${model.modelId} has unjudged cases (${String(Math.round(model.judgedShare * 100))}% judged)`,
      );
    }
    if (!Number.isFinite(model.docbench)) reasons.push(`${model.modelId} has no score`);
  }
  return reasons;
}

/** `major.minor` of a pack version: patch releases change no prompt or score. */
function packLine(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/**
 * Why a focused re-run cannot stand beside its published round, or an empty
 * list when it can: the same judge and prompts, fixtures, prompt date,
 * launch context, machine and pack line, and every model in both.
 */
export function rerunRefusals(
  summary: DocbenchSummary,
  against: DocbenchSummary,
  models: readonly string[],
): string[] {
  const reasons = publishRefusals(against).map((reason) => `the published round: ${reason}`);
  if (models.length === 0) reasons.push('no models named for the re-run');
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      reasons.push(`${what} differs from the published round`);
  };
  same('the judge', summary.judge, against.judge);
  same('the fixture set', summary.pack.fixtures, against.pack.fixtures);
  same('the prompt date', summary.now, against.now);
  same('the launch context', summary.launchContext, against.launchContext);
  same('the machine', summary.device, against.device);
  same('the pack line', packLine(summary.pack.version), packLine(against.pack.version));
  for (const id of models) {
    if (!summary.models.some((model) => model.modelId === id)) {
      reasons.push(`${id} is not in this round`);
    }
    if (!against.models.some((model) => model.modelId === id)) {
      reasons.push(`${id} is not in the published round`);
    }
  }
  return reasons;
}

/** Each re-run model's band within the published field, its old result replaced. */
function bandsInPublishedField(
  summary: DocbenchSummary,
  against: DocbenchSummary,
  models: readonly string[],
): Map<string, number> {
  const field = [
    ...against.models.filter((model) => !models.includes(model.modelId)),
    ...summary.models.filter((model) => models.includes(model.modelId)),
  ].map((model) => ({ id: model.modelId, score: model.docbench, ci: model.ci }));
  return assignBands(field);
}

/** 0–1 → 0–100, one decimal, clamped: what the published shapes store. */
function hundred(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 1000) / 10));
}

function hundredInterval(ci: Interval): [number, number] {
  return [hundred(ci[0]), hundred(ci[1])];
}

/** The overall score is already 0–100. */
function points(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** The scorecard run id for a docbench round. */
export function docbenchScorecardRunId(summary: Pick<DocbenchSummary, 'runId'>): string {
  return summary.runId.startsWith('docbench-') ? summary.runId : `docbench-${summary.runId}`;
}

function scorecardRun(input: DocbenchPublishInput): ScorecardRun {
  const { summary, manifest, rerun } = input;
  const judge = summary.judge!;
  const fixtures = summary.pack.fixtures;
  return {
    id: docbenchScorecardRunId(summary),
    ...(rerun ? { scope: 'subset' as const } : {}),
    provenance: {
      startedAt: summary.createdAt,
      device: summary.device,
      harnessCommit: summary.harnessCommit ?? 'unknown',
      gildeVersion: input.gildeVersion,
      count: Math.max(1, ...manifest.tasks.map((task) => task.trials)),
      judgeModelId: judge.model,
    },
    suites: [DOCBENCH_SUITE_ID],
    scenariosBySuite: { [DOCBENCH_SUITE_ID]: manifest.tasks.map((task) => task.id) },
    note: [
      rerun
        ? `Focused re-run of ${rerun.models.join(', ')} beside ${docbenchScorecardRunId(rerun.against)}, after fixes to how Gezel serves them; bands place them in that round's field`
        : null,
      `docbench ${summary.pack.version}`,
      fixtures ? `${fixtures.id} fixtures ${fixtures.sha256.slice(0, 12)}` : null,
      `${String(summary.launchContext)}-token launch context`,
      `judge ${judge.model} (prompt v${String(judge.promptVersion)})`,
      `prompts dated ${summary.now.slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

function docbenchBlock(
  summary: DocbenchSummary,
  model: ModelSummary,
  band: number,
): ScorecardDocbench {
  const judge = summary.judge!;
  return {
    packVersion: summary.pack.version,
    ...(summary.pack.fixtures ? { fixtures: summary.pack.fixtures } : {}),
    score: points(model.docbench),
    ci: [points(model.ci[0]), points(model.ci[1])],
    band: Math.max(1, band),
    usableRate: model.usableRate,
    families: Object.fromEntries(
      Object.entries(model.families).map(([id, family]) => [
        id,
        { score: hundred(family.score), ci: hundredInterval(family.ci) },
      ]),
    ),
    tasks: Object.fromEntries(
      Object.entries(model.tasks).map(([id, task]) => [
        id,
        {
          score: hundred(task.score),
          ci: hundredInterval(task.ci),
          usableRate: task.usableRate,
          medianOutputTokens: task.medianOutputTokens,
          ...(task.findings
            ? {
                findings: {
                  low: task.findings.perOutput.low,
                  medium: task.findings.perOutput.medium,
                  high: task.findings.perOutput.high,
                  trivial: task.findings.perOutput.trivial,
                  wrong: task.findings.perOutput.wrong,
                },
              }
            : {}),
        },
      ]),
    ),
    judge: {
      model: judge.model,
      promptVersion: judge.promptVersion,
      validityPassed: summary.validity?.pass === true,
    },
  };
}

/**
 * The round as a scorecard shard and catalog entries. Throws when the round
 * is not publishable or a model is not in the catalog: a score with no
 * build to attach it to would rank nothing, or the wrong thing.
 */
export function docbenchPublication(input: DocbenchPublishInput): DocbenchPublication {
  const refusals = publishRefusals(input.summary);
  if (refusals.length > 0) {
    throw new Error(
      `docbench round ${input.summary.runId} is not publishable:\n- ${refusals.join('\n- ')}`,
    );
  }
  const { summary, manifest, engine, rerun } = input;
  if (rerun) {
    const reasons = rerunRefusals(summary, rerun.against, rerun.models);
    if (reasons.length > 0) {
      throw new Error(
        `docbench round ${summary.runId} cannot stand beside ${rerun.against.runId}:\n- ${reasons.join('\n- ')}`,
      );
    }
  }
  const bands = rerun ? bandsInPublishedField(summary, rerun.against, rerun.models) : null;
  const run = scorecardRun(input);
  const warnings: string[] = [];
  const results: ScorecardModelResult[] = [];
  const benchmarks = new Map<string, DocbenchCatalogScore>();
  const published = rerun
    ? summary.models.filter((model) => rerun.models.includes(model.modelId))
    : summary.models;
  for (const model of published) {
    const facts = input.facts(model.modelId);
    if (!facts) throw new Error(`${model.modelId} is not in the chat-model catalog`);
    const docbench = docbenchBlock(summary, model, bands?.get(model.modelId) ?? model.band);
    results.push({
      modelId: model.modelId,
      label: facts.label,
      engine,
      tier: facts.tier,
      ...(facts.parameterSize ? { parameterSize: facts.parameterSize } : {}),
      ...(facts.quantization ? { quantization: facts.quantization } : {}),
      runId: run.id,
      suiteId: DOCBENCH_SUITE_ID,
      docbench,
      // One cell per task, counting usable replies, so the round has the
      // dataset's usual shape. Nothing reads these as passes.
      cells: manifest.tasks.flatMap((task) => {
        const result = model.tasks[task.id];
        if (!result) return [];
        return [
          {
            scenarioId: task.id,
            trials: result.trials + result.infraFailures,
            successes: Math.round(result.usableRate * result.trials),
            nonModelFailures: result.infraFailures,
          },
        ];
      }),
    });
    const catalogVersion = model.generation?.catalogVersion ?? facts.catalogVersion;
    if (!catalogVersion) throw new Error(`${model.modelId}: no catalog version to stamp`);
    if (!model.generation?.catalogVersion) {
      warnings.push(
        `${model.modelId}: generation did not record its catalog version; stamping the catalog's current ${catalogVersion}`,
      );
    }
    benchmarks.set(model.modelId, {
      version: summary.pack.version,
      score: docbench.score,
      ci: docbench.ci,
      band: docbench.band,
      families: Object.fromEntries(
        Object.entries(docbench.families).map(([id, family]) => [id, family.score]),
      ),
      usableRate: Math.round(model.usableRate * 1000) / 1000,
      catalogVersion,
      runId: run.id,
      measuredAt: summary.createdAt,
      judge: summary.judge!.model,
    });
  }
  return {
    shard: { schemaVersion: SCORECARD_SCHEMA_VERSION, runs: [run], results },
    benchmarks,
    warnings,
  };
}

/** Fields a Gilde manifest keeps after its eval-tuned ones; `benchmarks` goes before them. */
const AFTER_BENCHMARKS = ['yankedVersions', 'ollama', 'llamaCpp', 'mlx', 'ds4'];

/**
 * A recipe or identity manifest with this engine's docbench score set,
 * keeping every other engine's and every other benchmark. The key lands
 * where Gilde's own assembly puts it, so a later rebuild is not a diff.
 */
export type WithDocbench<T> = T & {
  benchmarks: { docbench: Record<string, DocbenchCatalogScore> };
};

export function withDocbenchBenchmark<T extends Record<string, unknown>>(
  manifest: T,
  engine: string,
  score: DocbenchCatalogScore,
): WithDocbench<T> {
  const previous = (manifest.benchmarks ?? {}) as {
    docbench?: Record<string, DocbenchCatalogScore>;
  };
  const benchmarks = { ...previous, docbench: { ...previous.docbench, [engine]: score } };
  if ('benchmarks' in manifest) return { ...manifest, benchmarks };
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(manifest)) {
    if (!placed && AFTER_BENCHMARKS.includes(key)) {
      out.benchmarks = benchmarks;
      placed = true;
    }
    out[key] = value;
  }
  if (!placed) out.benchmarks = benchmarks;
  return out as WithDocbench<T>;
}
