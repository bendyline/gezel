/**
 * ModelFitnessManager — orchestrates fitness probes (see probe.ts) and
 * owns the persisted records in `config.modelFitness`.
 *
 * Orchestration rules:
 * - All probes serialize through one promise chain (a probe spawns a
 *   real engine; two at once would fight over the capacity budget).
 * - Per-key dedupe: scheduling a probe that is already queued or
 *   running joins it instead of double-running.
 * - Eviction politeness: an INSTALL-triggered probe defers while the
 *   pool has no headroom for the model (spawning would evict a
 *   resident engine mid-use); it retries for a bounded window, then
 *   persists a `deferred` record. MANUAL probes proceed immediately —
 *   the user asked.
 *
 * Persistence rules:
 * - The whole `modelFitness` map is read-modify-written inside the
 *   serialized chain (Store.writeConfig shallow-merges fields; the
 *   manager is the only writer of this one).
 * - Reads `safeParse` each entry against `ModelFitnessRecordSchema`
 *   and skip invalid ones — a mangled record never breaks the list.
 */

import type { GezelConfig, ModelFitnessRecord, ModelFitnessTrigger } from '@bendyline/gezel';
import { ModelFitnessRecordSchema, createLogger, modelFitnessKey } from '@bendyline/gezel';
import { CapacityBroker } from '../providers/native/capacity-broker.js';
import type { PoolSnapshot } from '../providers/native/provider-pool.js';
import type { FitnessEngine, FitnessProbeArgs } from './probe.js';

const log = createLogger('fitness');

const DEFER_RETRY_MS = 90_000;
const DEFER_BUDGET_MS = 20 * 60_000;
/** Host-memory drift beyond this fraction softens the badge. */
const HARDWARE_DRIFT_FRACTION = 0.1;

export interface ResolvedModelFitness {
  record: ModelFitnessRecord;
  /** Installed weights/version changed since the probe — treat as unprobed. */
  stale: boolean;
  /** Host memory changed materially since the probe — soften, don't invalidate. */
  hardwareChanged: boolean;
}

export interface ModelFitnessManagerOptions {
  store: {
    readConfig(): Promise<GezelConfig>;
    writeConfig(config: Partial<Record<keyof GezelConfig, unknown>>): Promise<GezelConfig>;
  };
  runProbe: (args: FitnessProbeArgs) => Promise<ModelFitnessRecord>;
  resolveInstalled: (
    engine: FitnessEngine,
    modelId: string,
  ) => Promise<{ sha256?: string; catalogVersion?: string; approxSizeBytes: number } | null>;
  engineStatus: () => Promise<PoolSnapshot | null>;
  currentMemory: () => Promise<{ totalRamBytes: number; gpuVramBytes: number | null }>;
  sleep?: (ms: number) => Promise<void>;
  deferRetryMs?: number;
  deferBudgetMs?: number;
  now?: () => number;
}

export class ModelFitnessManager {
  private readonly opts: ModelFitnessManagerOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();

  constructor(opts: ModelFitnessManagerOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Keys ("provider:modelId") with a probe queued or running. */
  probingKeys(): string[] {
    return Array.from(this.pending);
  }

  /**
   * Queue a probe. Returns synchronously — the probe runs on the
   * serialized background chain. A key already queued or running is
   * joined, not re-run.
   */
  scheduleProbe(
    provider: FitnessEngine,
    modelId: string,
    opts: { trigger: ModelFitnessTrigger },
  ): void {
    const key = modelFitnessKey(provider, modelId);
    if (this.pending.has(key)) {
      log.debug(`proeve ${key} already pending — joining`);
      return;
    }
    this.pending.add(key);
    const run = async () => {
      try {
        await this.runOne(provider, modelId, opts.trigger);
      } catch (err) {
        // runOne persists its own failure records; this catches only
        // persistence/machinery escapes so the chain never breaks.
        log.warn(`proeve ${key} escaped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.pending.delete(key);
      }
    };
    this.chain = this.chain.then(run, run);
  }

  private async runOne(
    provider: FitnessEngine,
    modelId: string,
    trigger: ModelFitnessTrigger,
  ): Promise<void> {
    if (trigger === 'install') {
      const ok = await this.waitForHeadroom(provider, modelId);
      if (!ok) {
        log.info(
          `proeve ${provider}/${modelId}: no capacity headroom after defer budget — deferred`,
        );
        await this.persist(await this.buildDeferredRecord(provider, modelId, trigger));
        return;
      }
    }
    const record = await this.opts.runProbe({ provider, modelId, trigger });
    await this.persist(record);
  }

  /**
   * True when spawning the model would not force-evict a resident
   * engine (or when there is nothing to be polite about: no pool, an
   * unenforced budget, or the model already resident).
   */
  private async headroomAvailable(provider: FitnessEngine, modelId: string): Promise<boolean> {
    const snapshot = await this.opts.engineStatus().catch(() => null);
    if (!snapshot || !snapshot.enforced) return true;
    const resident = snapshot.entries.some((e) => e.provider === provider && e.modelId === modelId);
    if (resident) return true;
    if (snapshot.entries.length === 0) return true;
    const installed = await this.opts.resolveInstalled(provider, modelId).catch(() => null);
    if (!installed) return true;
    const estimate = CapacityBroker.estimateResidentBytes(provider, installed.approxSizeBytes);
    return snapshot.committedBytes + estimate <= snapshot.budgetBytes;
  }

  private async waitForHeadroom(provider: FitnessEngine, modelId: string): Promise<boolean> {
    const retryMs = this.opts.deferRetryMs ?? DEFER_RETRY_MS;
    const budgetMs = this.opts.deferBudgetMs ?? DEFER_BUDGET_MS;
    const start = this.now();
    while (true) {
      if (await this.headroomAvailable(provider, modelId)) return true;
      if (this.now() - start >= budgetMs) return false;
      await this.sleep(retryMs);
    }
  }

  private async buildDeferredRecord(
    provider: FitnessEngine,
    modelId: string,
    trigger: ModelFitnessTrigger,
  ): Promise<ModelFitnessRecord> {
    const host = await this.opts
      .currentMemory()
      .catch(() => ({ totalRamBytes: 0, gpuVramBytes: null }));
    const installed = await this.opts.resolveInstalled(provider, modelId).catch(() => null);
    const deferredCheck = {
      ok: false,
      detail: 'probe deferred — spawning would evict a resident model; run the check manually',
    };
    return {
      schemaVersion: 1,
      provider,
      modelId,
      status: 'deferred',
      admitted: false,
      genTokensPerSec: null,
      createdAt: new Date(this.now()).toISOString(),
      durationMs: 0,
      trigger,
      ...(installed?.sha256 ? { sha256: installed.sha256 } : {}),
      ...(installed?.catalogVersion ? { catalogVersion: installed.catalogVersion } : {}),
      host: { ...host, source: 'deferred' },
      checks: {
        spawn: deferredCheck,
        toolRoundTrip: deferredCheck,
        throughput: deferredCheck,
        reasoningBudget: deferredCheck,
        contextFit: deferredCheck,
      },
    };
  }

  private async persist(record: ModelFitnessRecord): Promise<void> {
    const config = await this.opts.store.readConfig();
    const map: Record<string, unknown> = { ...(config.modelFitness ?? {}) };
    map[modelFitnessKey(record.provider, record.modelId)] = record;
    await this.opts.store.writeConfig({ modelFitness: map });
  }

  async get(provider: string, modelId: string): Promise<ResolvedModelFitness | null> {
    const config = await this.opts.store.readConfig();
    const raw = config.modelFitness?.[modelFitnessKey(provider, modelId)];
    if (raw === undefined) return null;
    return this.resolve(raw);
  }

  async list(): Promise<Array<ResolvedModelFitness & { key: string }>> {
    const config = await this.opts.store.readConfig();
    const out: Array<ResolvedModelFitness & { key: string }> = [];
    for (const [key, raw] of Object.entries(config.modelFitness ?? {})) {
      const resolved = await this.resolve(raw);
      if (resolved) out.push({ key, ...resolved });
    }
    return out;
  }

  private async resolve(raw: unknown): Promise<ResolvedModelFitness | null> {
    const parsed = ModelFitnessRecordSchema.safeParse(raw);
    if (!parsed.success) return null;
    const record = parsed.data;
    return {
      record,
      stale: await this.isStale(record),
      hardwareChanged: await this.hardwareChanged(record),
    };
  }

  private async isStale(record: ModelFitnessRecord): Promise<boolean> {
    if (record.provider !== 'llama-cpp' && record.provider !== 'ds4') return false;
    const installed = await this.opts
      .resolveInstalled(record.provider, record.modelId)
      .catch(() => null);
    if (!installed) return true;
    if (record.sha256 && installed.sha256 && record.sha256 !== installed.sha256) return true;
    if (
      record.catalogVersion &&
      installed.catalogVersion &&
      record.catalogVersion !== installed.catalogVersion
    ) {
      return true;
    }
    return false;
  }

  private async hardwareChanged(record: ModelFitnessRecord): Promise<boolean> {
    if (record.host.totalRamBytes <= 0) return false;
    const current = await this.opts.currentMemory().catch(() => null);
    if (!current) return false;
    const ramDrift =
      Math.abs(current.totalRamBytes - record.host.totalRamBytes) / record.host.totalRamBytes;
    if (ramDrift > HARDWARE_DRIFT_FRACTION) return true;
    return (current.gpuVramBytes == null) !== (record.host.gpuVramBytes == null);
  }
}
