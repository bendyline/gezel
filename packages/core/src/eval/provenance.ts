/**
 * What the in-app Benchmarks view and `gezel bench` say about a run, shared
 * so the two surfaces cannot drift: the same note when a run is not a suite
 * score, the same provenance stamp, and the same way of turning one finished
 * job into a scorecard shard that the published dataset's tooling can ingest.
 *
 * Nothing here scores anything. Scoring stays in `results.ts` and the
 * scorecard's `report.ts`; this file only arranges their output.
 */

import { describeProvenance, hardwareSummary } from '../scorecard/report.js';
import {
  SCORECARD_SCHEMA_VERSION,
  type ScorecardCell,
  type ScorecardDataset,
  type ScorecardDevice,
  type ScorecardModelResult,
  type ScorecardRun,
} from '../scorecard/schema.js';
import { buildEvalMatrix } from './results.js';
import type { EvalCatalog, EvalCatalogSuite, EvalTarget, EvalTrialSummary } from './schemas.js';

/** Printed beside any run that covers only part of a suite. */
export const EVAL_SUBSET_NOTE =
  'A subset is useful for a quick check, but it is not a suite score.';

/** The four suites a published scorecard covers, in the order the Handboek prints them. */
export const SCORECARD_SUITE_IDS = ['core', 'productivity', 'developer', 'complex-work'] as const;
export type ScorecardSuiteId = (typeof SCORECARD_SUITE_IDS)[number];

/** How the Handboek names each scorecard suite. */
export const SCORECARD_SUITE_LABELS: Readonly<Record<ScorecardSuiteId, string>> = {
  core: 'General capability',
  productivity: 'Office and knowledge work',
  developer: 'Engineering work',
  'complex-work': 'Complex workflows',
};

/**
 * The pulse-check variant of a scorecard suite, when the catalog ships one.
 * `core`'s is named `smoke`; the others follow `<suite>-smoke`.
 */
export function smokeSuiteIdFor(
  suiteId: string,
  catalog: Pick<EvalCatalog, 'suites'>,
): string | null {
  const candidates = suiteId === 'core' ? ['smoke', 'core-smoke'] : [`${suiteId}-smoke`];
  return candidates.find((id) => catalog.suites.some((s) => s.id === id)) ?? null;
}

/** Whether a selection covers the whole suite; anything less is a subset. */
export function isSuiteSubset(suite: EvalCatalogSuite, scenarioIds: readonly string[]): boolean {
  const chosen = new Set(scenarioIds);
  return suite.scenarioIds.some((id) => !chosen.has(id));
}

/**
 * What a host reports about itself. A structural subset of the daemon's
 * system diagnostics, so callers can pass that response straight through
 * without this module depending on its schema.
 */
export interface EvalHostFacts {
  /** The daemon's version string. */
  version: string;
  runtime: { platform: string; arch: string; osRelease: string };
  hardware: { totalRamBytes: number; gpuDevices: ReadonlyArray<{ name: string }> };
  engine: { nativeRelease: string; llamaCppBackend?: string; llamaCppRevision?: string };
}

/**
 * The device half of a provenance stamp. `cpuModel` is optional because a
 * browser cannot read it; a terminal on the same machine can.
 */
export function evalDeviceFromHost(host: EvalHostFacts, cpuModel?: string): ScorecardDevice {
  const cpu = cpuModel?.trim();
  const gpu = host.hardware.gpuDevices[0]?.name?.trim();
  const platformLabel =
    host.runtime.platform === 'darwin'
      ? 'Mac'
      : host.runtime.platform === 'win32'
        ? 'Windows'
        : host.runtime.platform === 'linux'
          ? 'Linux'
          : host.runtime.platform;
  return {
    label: cpu ? `${platformLabel} · ${cpu}` : platformLabel,
    platform: host.runtime.platform,
    arch: host.runtime.arch,
    memoryGb: Math.max(1, Math.round(host.hardware.totalRamBytes / 1024 ** 3)),
    osRelease: `${host.runtime.platform} ${host.runtime.osRelease}`,
    ...(cpu ? { cpuModel: cpu } : {}),
    ...(gpu ? { gpuModel: gpu } : {}),
  };
}

/** Native engine identifiers worth pinning beside a result. */
export function evalEngineBuilds(host: EvalHostFacts): Record<string, string> {
  const builds: Record<string, string> = { native: host.engine.nativeRelease };
  if (host.engine.llamaCppRevision) builds['llama-cpp'] = host.engine.llamaCppRevision;
  if (host.engine.llamaCppBackend) builds['llama-cpp-backend'] = host.engine.llamaCppBackend;
  return builds;
}

/**
 * One line that says where a number came from, before any run starts:
 * hardware, engine build, gezel version. The same line heads the Benchmarks
 * view and `gezel bench`'s output.
 */
export function describeEvalHost(host: EvalHostFacts, cpuModel?: string): string {
  const device = evalDeviceFromHost(host, cpuModel);
  const engine = host.engine.llamaCppBackend
    ? `native ${host.engine.nativeRelease} (${host.engine.llamaCppBackend})`
    : `native ${host.engine.nativeRelease}`;
  return [hardwareSummary(device), engine, `gezel ${host.version}`].join(' · ');
}

export interface EvalRunProvenanceInput {
  /** Stable id for the run; `evalRunId` builds one. */
  id: string;
  startedAt: string;
  device: ScorecardDevice;
  /** The gezel version (a packaged install) or short git sha (a checkout). */
  gezelVersion: string;
  /** Exact `@bendyline/gilde` version, or `unknown`. */
  gildeVersion: string;
  count: number;
  engineBuilds?: Record<string, string>;
  /** Suite id → scenario ids as run. */
  scenariosBySuite: Record<string, readonly string[]>;
  /** Any suite covered only in part. */
  subset: boolean;
  note?: string;
}

/** A scorecard run record for a set of in-app or terminal jobs. */
export function evalRunProvenance(input: EvalRunProvenanceInput): ScorecardRun {
  const scenariosBySuite: Record<string, string[]> = {};
  for (const [suite, ids] of Object.entries(input.scenariosBySuite)) {
    scenariosBySuite[suite] = [...ids];
  }
  return {
    id: input.id,
    provenance: {
      startedAt: input.startedAt,
      device: input.device,
      harnessCommit: input.gezelVersion,
      gildeVersion: input.gildeVersion,
      count: input.count,
      judgeModelId: null,
      ...(input.engineBuilds ? { engineBuilds: input.engineBuilds } : {}),
    },
    ...(input.subset ? { scope: 'subset' as const } : {}),
    suites: Object.keys(scenariosBySuite),
    scenariosBySuite,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** `YYYY-MM-DD-<host>-<model>`, lower-case, like the published rounds. */
export function evalRunId(startedAt: string, device: ScorecardDevice, modelId: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const host = slug(device.cpuModel ?? device.gpuModel ?? device.label) || device.platform;
  return `${startedAt.slice(0, 10)}-${host}-${slug(modelId)}`;
}

/** The stamp printed beside a finished run; the handboek prints runs the same way. */
export function describeEvalRun(run: ScorecardRun, engines: readonly string[] = []): string {
  return describeProvenance(run, engines);
}

export interface EvalSuiteShardInput {
  run: ScorecardRun;
  suite: EvalCatalogSuite;
  target: Pick<EvalTarget, 'provider' | 'modelId' | 'label'>;
  /** Trials from the job that ran this suite, finished or not. */
  trials: readonly EvalTrialSummary[];
}

/**
 * One model's result on one suite, in the dataset's shape, built with the
 * same matrix the Benchmarks view renders. Running trials are not counted;
 * trials cut short with no verdict measured nothing.
 */
export function evalSuiteResult(input: EvalSuiteShardInput): ScorecardModelResult {
  const matrix = buildEvalMatrix(input.trials, { scenarioOrder: input.suite.scenarioIds });
  const column = matrix.columns.find(
    (c) =>
      c.modelId === input.target.modelId &&
      (c.provider ?? input.target.provider) === input.target.provider,
  );
  const cells: ScorecardCell[] = input.suite.scenarioIds.map((scenarioId) => {
    const cell = column ? matrix.cell(scenarioId, column.key) : undefined;
    return cell
      ? {
          scenarioId: cell.scenarioId,
          trials: cell.trials,
          successes: cell.successes,
          nonModelFailures: cell.nonModelFailures,
          ...(cell.medianDurationMs !== undefined
            ? { medianDurationMs: cell.medianDurationMs }
            : {}),
        }
      : { scenarioId, trials: 0, successes: 0, nonModelFailures: 0 };
  });
  const tiers = input.trials.map((t) => t.modelTier).filter((t): t is string => Boolean(t));
  return {
    modelId: input.target.modelId,
    label: input.target.label,
    engine: input.target.provider,
    tier: tiers[0] ?? 'unknown',
    runId: input.run.id,
    suiteId: input.suite.id,
    cells,
  };
}

/** A dataset shard holding one run and its per-suite results. */
export function evalShard(
  run: ScorecardRun,
  results: readonly ScorecardModelResult[],
): ScorecardDataset {
  return { schemaVersion: SCORECARD_SCHEMA_VERSION, runs: [run], results: [...results] };
}

/** Median decode rate the perf collector saw across a job's finished trials. */
export function medianDecodeTokensPerSec(trials: readonly EvalTrialSummary[]): number | null {
  const rates = trials
    .map((t) => t.decodeTokensPerSec)
    .filter((r): r is number => typeof r === 'number' && r > 0)
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 === 1 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}
