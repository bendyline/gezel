import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import type { EngineBinaryRegistry } from '../engines/registry.js';
import type { SecretStore } from '../secrets/types.js';
import { EvalCatalogCache } from './catalog.js';
import { type EvalHarness, resolveEvalHarness } from './harness.js';
import { type EvalHistorySink, EvalJobManager } from './jobs.js';
import { EvalResultsIndex } from './results.js';
import { type EvalTargetDeps, EvalTargets } from './targets.js';

/** Where in-app runs live: `<home>/eval-runs/`. Owned by this module. */
export function evalRunsDir(home: string): string {
  return join(home, 'eval-runs');
}

export interface EvalServiceDeps {
  home: string;
  readConfig: () => Promise<GezelConfig>;
  secrets: Pick<SecretStore, 'get'>;
  engineBinaries: Pick<EngineBinaryRegistry, 'ensure' | 'subscribe' | 'get'>;
  llamaCppModels: EvalTargetDeps['llamaCppModels'];
  mlxModels: EvalTargetDeps['mlxModels'];
  ds4Models: EvalTargetDeps['ds4Models'];
  history?: EvalHistorySink;
  /** Test seam; production resolves the harness beside this module. */
  harness?: () => EvalHarness | null;
}

/**
 * The daemon's eval surface: the harness catalog, runnable targets, queued
 * jobs, and the index of finished trials. One instance per daemon, built at
 * boot and stopped at shutdown so a running harness never outlives it.
 */
export class EvalService {
  readonly runsDir: string;
  readonly catalog: EvalCatalogCache;
  readonly targets: EvalTargets;
  readonly jobs: EvalJobManager;
  readonly results: EvalResultsIndex;
  private resolvedHarness: EvalHarness | null | undefined;

  constructor(deps: EvalServiceDeps) {
    this.runsDir = evalRunsDir(deps.home);
    const harness = deps.harness ?? (() => this.resolveHarness());
    this.catalog = new EvalCatalogCache(harness);
    this.targets = new EvalTargets({
      home: deps.home,
      runsDir: this.runsDir,
      readConfig: deps.readConfig,
      secrets: deps.secrets,
      engineBinaries: deps.engineBinaries,
      llamaCppModels: deps.llamaCppModels,
      mlxModels: deps.mlxModels,
      ds4Models: deps.ds4Models,
      harness,
      catalog: () => this.catalog.get(),
    });
    this.jobs = new EvalJobManager({
      runsDir: this.runsDir,
      harness,
      prepareTarget: (target, spec) => this.targets.prepare(target, spec),
      ...(deps.history ? { history: deps.history } : {}),
    });
    this.results = new EvalResultsIndex(this.runsDir, () => this.jobs.liveTrialIds());
  }

  harness(): EvalHarness | null {
    return this.resolveHarness();
  }

  async shutdown(): Promise<void> {
    await this.jobs.shutdown();
  }

  private resolveHarness(): EvalHarness | null {
    if (this.resolvedHarness === undefined) this.resolvedHarness = resolveEvalHarness();
    return this.resolvedHarness;
  }
}
