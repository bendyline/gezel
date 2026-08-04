/**
 * CapacityBroker — single source of truth for "do we have headroom
 * to load another local model?" Sums per-engine `residentBytes`
 * reservations against a budget (auto-derived from system RAM, or
 * explicitly set in config) and decides reserve / deny.
 *
 * The broker tracks reservations, not actual RSS. Treating
 * `residentBytes` from the catalog as the source of truth keeps the
 * logic deterministic and fast — a polling RSS reader would race the
 * reserve→spawn window where committed > actual. The catalog number
 * intentionally over-estimates (working set + buffers), so the broker
 * is conservative in the right direction.
 *
 * Lifecycle: every supervisor spawn calls `reserve(key, bytes)`;
 * every supervisor stop (idle, eviction, shutdown) calls
 * `release(key)`. The pool decides what to do when `reserve` returns
 * false — typically: pick LRU and evict, then retry.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { createLogger } from '@bendyline/gezel';
import {
  type CapacityBudget,
  autoAllowRamSpillover,
  computeCapacityBudget,
} from './capacity-budget.js';
import type { LocalProviderName } from './engine-key.js';

export {
  autoAllowRamSpillover,
  autoDetectBudgetBytes,
  computeCapacityBudget,
  fastMemoryBudgetBytes,
  getDetectedGpuVramBytes,
  setDetectedGpuVramBytes,
  type CapacityBudget,
} from './capacity-budget.js';

const log = createLogger('capacity-broker');

export type EngineKey = string;

export interface CapacityBrokerOptions {
  /**
   * Total budget in bytes. Pass `undefined` to derive from system RAM
   * via {@link autoDetectBudgetBytes}. Pass `0` (or any value <
   * 1 GB) to disable enforcement — the broker still tracks
   * reservations but `canReserve` always returns true. Useful for
   * tests and for users who want to opt out of the budget entirely.
   */
  budgetBytes?: number;
  /** Test seam — defaults to {@link totalmem}. */
  systemRamBytes?: () => number;
  /**
   * Whether this host shares one memory pool between CPU and GPU, which
   * changes the auto-derived budget. Defaults to detecting the running
   * host; pass it explicitly in tests so the expected budget doesn't
   * depend on which machine the suite runs on.
   */
  unifiedMemory?: boolean;
  /**
   * Measured discrete-GPU VRAM, or null for none. A card's memory is added
   * to the RAM share rather than replacing it — see
   * {@link computeCapacityBudget}. Omit to read the last published probe.
   */
  gpuVramBytes?: number | null;
  /**
   * May co-resident models spill into system RAM? `null`/omitted follows
   * {@link autoAllowRamSpillover} for this host. See
   * {@link CapacityBroker.coResidencyBytes}.
   */
  allowRamSpillover?: boolean | null;
}

export interface CapacityCommitted {
  budgetBytes: number;
  committedBytes: number;
  enforced: boolean;
  /** Total physical RAM the budget was derived from (for messaging). */
  systemRamBytes: number;
  /**
   * What {@link autoDetectBudgetBytes} would pick for this host, whether or
   * not an explicit budget is in force. The Settings slider marks it on the
   * track so "Auto" stays a visible position rather than a hidden default.
   */
  autoBudgetBytes: number;
  /** True when an explicit budget is overriding {@link autoBudgetBytes}. */
  overridden: boolean;
  /**
   * Which pools the auto budget draws on, so the UI and the denial message
   * can name the memory a person actually has instead of describing a 24 GB
   * card's models as a percentage of system RAM.
   */
  pools: {
    kind: CapacityBudget['kind'];
    /** Usable VRAM on a discrete card; 0 on unified / CPU-only hosts. */
    vramBytes: number;
    /** The system-RAM share of the auto budget. */
    ramShareBytes: number;
    /** Fast (on-accelerator) memory — VRAM on a card, the budget otherwise. */
    fastBytes: number;
  };
  /** Whether co-resident models may spill into system RAM, and how that was decided. */
  ramSpillover: {
    allowed: boolean;
    /** What this host would pick on its own; the toggle's "Auto" position. */
    auto: boolean;
    /** True when an explicit setting is overriding {@link auto}. */
    overridden: boolean;
    /**
     * The ceiling the resident set must fit under while more than one model
     * is loaded. Equals {@link budgetBytes} when spilling is allowed.
     */
    coResidencyBytes: number;
  };
  byKey: Array<{ key: EngineKey; bytes: number }>;
}

/** Format a byte count as GB with one decimal (e.g. `14.3 GB`). */
function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Turn a raw capacity denial into a human-readable, actionable
 * message. The raw broker reason (`budget exhausted: would commit
 * 14326180192 against 10307921510`) is fine for logs but unreadable in
 * a chat bubble — this is what the user actually sees when a model is
 * too big to load.
 */
export function formatCapacityDenial(opts: {
  /** Friendly model name, e.g. `gemma4-12b-q4` (not the engine key). */
  modelLabel: string;
  /** Bytes the model needs resident. */
  requestedBytes: number;
  /** Total model budget. */
  budgetBytes: number;
  /** Bytes already reserved by other resident models. */
  committedBytes: number;
  /** Physical RAM the budget was derived from; 0 when unknown. */
  systemRamBytes: number;
  /**
   * Which pools the budget draws on. Omit on a RAM-only host. Without this
   * the message describes a 24 GB card's budget as a percentage of system
   * RAM — the number a person with a GPU is least likely to recognize.
   */
  pools?: CapacityCommitted['pools'];
  /**
   * The co-residency ceiling, when it is tighter than the budget — i.e. when
   * this refusal is "keep models on the card", not "out of memory".
   */
  coResidencyBytes?: number;
}): string {
  const { modelLabel, requestedBytes, budgetBytes, committedBytes, systemRamBytes, pools } = opts;
  // A co-residency refusal is a different problem with different advice: the
  // machine has the memory, but keeping this model on the card means the
  // others cannot stay. It only reaches a user when eviction couldn't clear
  // the room (every other model busy), so "wait or close a chat" is the fix,
  // not "buy a smaller model".
  if (opts.coResidencyBytes !== undefined && opts.coResidencyBytes < budgetBytes) {
    return [
      `Not enough graphics memory to add ${modelLabel} (about ${formatGb(requestedBytes)}) `,
      `next to the models already loaded (${formatGb(committedBytes)} of `,
      `${formatGb(opts.coResidencyBytes)}). Gezel is set to keep models on the graphics card `,
      'rather than let them spill into system memory, so it unloads one model to make room for ',
      'another — but every loaded model is busy right now. Wait for a turn to finish, or allow ',
      'system-memory spillover in Settings under the engine that runs it, which keeps them all ',
      'loaded at reduced speed.',
    ].join('');
  }
  const free = Math.max(0, budgetBytes - committedBytes);
  const parts = [
    `Not enough memory to run ${modelLabel}: it needs about ${formatGb(requestedBytes)}, ` +
      `but only ${formatGb(free)} is available for models`,
  ];
  if (pools && pools.kind === 'discrete-gpu' && pools.vramBytes > 0) {
    parts.push(
      ` (the model budget is ${formatGb(budgetBytes)} — ${formatGb(pools.vramBytes)} of ` +
        `graphics memory plus ${formatGb(pools.ramShareBytes)} of this machine's ` +
        `${formatGb(systemRamBytes)} system memory, with the rest left for everything else)`,
    );
  } else if (systemRamBytes > 0) {
    const pct = Math.round((budgetBytes / systemRamBytes) * 100);
    parts.push(
      ` (the model budget is ${formatGb(budgetBytes)} — about ${pct}% of your ` +
        `${formatGb(systemRamBytes)} machine, with the rest left for everything else)`,
    );
  } else {
    parts.push(` (model budget ${formatGb(budgetBytes)})`);
  }
  parts.push('. ');
  if (committedBytes > 0) {
    parts.push(
      `Other models are currently using ${formatGb(committedBytes)}; closing one may free enough room. `,
    );
  }
  parts.push(
    'Try a smaller or more-quantized model, or raise the memory budget in ' +
      'Settings under the engine that runs it — at your own risk, since a ' +
      'budget the machine cannot back may make the app run out of memory.',
  );
  return parts.join('');
}

/**
 * A model that could not be admitted for lack of memory. The message is
 * unchanged from what `formatCapacityDenial` always produced — the class
 * exists purely so `describeTurnError` can tell an out-of-memory refusal
 * apart from an engine crash, since the two need very different advice in
 * a bug report.
 */
export class CapacityDeniedError extends Error {
  readonly code = 'capacity-denied';

  constructor(message: string) {
    super(message);
    this.name = 'CapacityDeniedError';
  }
}

/**
 * A resident engine could not be evicted in time to make room because it
 * was still serving requests. Unlike {@link CapacityDeniedError} this is a
 * *transient* condition — nothing is wrong with the model that wanted room;
 * the caller should retry once current turns drain. The `code` lets the
 * fitness probe classify the failure as "did not run" rather than "failed".
 */
export class EngineBusyError extends Error {
  readonly code = 'engine-busy';

  constructor(message: string) {
    super(message);
    this.name = 'EngineBusyError';
  }
}

export class CapacityBroker {
  private budgetBytes: number;
  private enforced: boolean;
  private explicitBudgetBytes: number | null;
  private readonly systemRamBytes: number;
  private readonly unifiedMemory: boolean | undefined;
  private readonly gpuVramBytes: number | null | undefined;
  private explicitAllowRamSpillover: boolean | null;
  private readonly reservations = new Map<EngineKey, number>();

  constructor(opts: CapacityBrokerOptions = {}) {
    this.systemRamBytes = (opts.systemRamBytes ?? totalmem)();
    this.unifiedMemory = opts.unifiedMemory;
    this.gpuVramBytes = opts.gpuVramBytes;
    this.explicitAllowRamSpillover = opts.allowRamSpillover ?? null;
    this.explicitBudgetBytes = opts.budgetBytes ?? null;
    // Assigned by applyBudget; the definite-assignment dance TS wants for
    // fields a constructor sets through a helper.
    this.budgetBytes = 0;
    this.enforced = false;
    this.applyBudget();
  }

  private autoBudget(): CapacityBudget {
    return computeCapacityBudget({
      systemRamBytes: this.systemRamBytes,
      ...(this.unifiedMemory === undefined ? {} : { unifiedMemory: this.unifiedMemory }),
      ...(this.gpuVramBytes === undefined ? {} : { gpuVramBytes: this.gpuVramBytes }),
    });
  }

  private applyBudget(): void {
    const explicit = this.explicitBudgetBytes;
    if (explicit === null) {
      this.budgetBytes = this.autoBudget().budgetBytes;
      this.enforced = true;
    } else if (explicit < 1024 ** 3) {
      this.budgetBytes = explicit;
      this.enforced = false;
    } else {
      this.budgetBytes = explicit;
      this.enforced = true;
    }
  }

  /**
   * Re-point the budget without rebuilding the broker. `null` reverts to
   * {@link autoDetectBudgetBytes}. Existing reservations are untouched: a
   * shrink below current commitments doesn't evict anything, it just makes
   * the next `reserve` fail until the pool's LRU path frees room. That is
   * the same shape as the cache controller's live budget, and it keeps the
   * Settings slider from severing a mid-turn engine.
   *
   * Without this the budget was read once when the engine router was built
   * and cached until shutdown, so changing the setting did nothing until
   * the daemon restarted.
   */
  setBudgetBytes(bytes: number | null): void {
    this.explicitBudgetBytes = bytes;
    this.applyBudget();
    log.info(
      `budget set to ${this.budgetBytes} (${bytes === null ? 'auto' : 'explicit'}), ` +
        `committed ${this.committedBytes()}`,
    );
  }

  /**
   * Live-update whether co-resident models may spill into system RAM.
   * `null` reverts to {@link autoAllowRamSpillover}. Like
   * {@link setBudgetBytes}, tightening never evicts anything itself — it
   * makes the next reserve fail, and the pool's LRU path does the freeing.
   */
  setAllowRamSpillover(allow: boolean | null): void {
    this.explicitAllowRamSpillover = allow;
    log.info(
      `ram spillover ${this.ramSpilloverAllowed() ? 'allowed' : 'denied'} ` +
        `(${allow === null ? 'auto' : 'explicit'}), co-residency ceiling ${this.coResidencyBytes()}`,
    );
  }

  /** Whether co-resident models may spill into system RAM right now. */
  ramSpilloverAllowed(): boolean {
    return this.explicitAllowRamSpillover ?? autoAllowRamSpillover(this.autoBudget());
  }

  /**
   * The ceiling the resident set must fit under **while more than one model
   * is loaded**. Equal to the budget when spilling is allowed; the card's
   * usable VRAM when it isn't.
   *
   * The single-model carve-out is the whole point of expressing this as a
   * co-residency rule rather than a smaller budget: one model may still use
   * the full budget, so a MoE larger than the card keeps running by streaming
   * its experts from system RAM. What the rule forbids is a *second* model
   * pushing the resident set off the card, where every model in it gets slow
   * at once. Capping the budget instead would have made that big MoE
   * unloadable and quietly shrunk the catalog to what fits in VRAM.
   */
  coResidencyBytes(): number {
    if (this.ramSpilloverAllowed()) return this.budgetBytes;
    return Math.min(this.budgetBytes, this.fastBudgetBytes());
  }

  /** True iff a fresh reservation of `bytes` would fit. */
  canReserve(bytes: number): boolean {
    return this.shortfallFor(bytes) <= 0;
  }

  /**
   * Bytes of existing reservation that must be released before `bytes` fits
   * — 0 when it already does. Both constraints in one number so the pool can
   * size an eviction batch without knowing which rule bound it.
   *
   * `priorBytes` is an existing reservation for the same key being resized;
   * it is not an obstacle to itself.
   */
  shortfallFor(bytes: number, priorBytes = 0): number {
    if (!this.enforced) return 0;
    const others = Math.max(0, this.committedBytes() - priorBytes);
    const budgetShort = others + bytes - this.budgetBytes;
    // Co-residency binds only while something else is loaded. Releasing X
    // satisfies it once `others - X + bytes <= ceiling` OR `others - X === 0`
    // — hence the min: a model bigger than the ceiling needs the pool empty,
    // never more than everything.
    const ceiling = this.coResidencyBytes();
    const coShort =
      others > 0 ? Math.min(others, others + bytes - ceiling) : Number.NEGATIVE_INFINITY;
    return Math.max(0, budgetShort, coShort);
  }

  /**
   * Attempt to reserve `bytes` for `key`. Returns the result; on
   * `granted: false` the caller is expected to evict and retry.
   *
   * Idempotent on `key`: a second reserve for the same key replaces
   * the prior bytes value (useful when an engine's working set grows
   * after first turn). The replacement is treated as "free old, add
   * new" so an enlargement that no longer fits returns false and
   * leaves the prior reservation intact.
   */
  reserve(key: EngineKey, bytes: number): { granted: boolean; reason?: string } {
    const prior = this.reservations.get(key) ?? 0;
    if (!this.enforced) {
      this.reservations.set(key, bytes);
      return { granted: true };
    }
    if (this.shortfallFor(bytes, prior) > 0) {
      return {
        granted: false,
        reason: this.denialReason(bytes, prior),
      };
    }
    this.reservations.set(key, bytes);
    if (prior > 0 && prior !== bytes) {
      log.debug(`reserve ${key} resized ${prior} → ${bytes}`);
    } else if (prior === 0) {
      log.debug(
        `reserve ${key} = ${bytes} (committed ${this.committedBytes()}/${this.budgetBytes})`,
      );
    }
    return { granted: true };
  }

  /**
   * The raw machine-shaped reason for a denial of `bytes` (optionally
   * replacing an existing `priorBytes` reservation). Single source of
   * the `budget exhausted: would commit N against M` string — it feeds
   * both `reserve()` results and the pool's `capacity broker denied`
   * log line, whose shape is a contract with the eval harness (see
   * provider-pool.ts). Do not reword. A co-residency denial keeps that
   * exact prefix and only appends its own clause, so the harness's
   * `capacity broker denied … budget exhausted` match still classifies it.
   */
  denialReason(bytes: number, priorBytes = 0): string {
    const wouldCommit = this.committedBytes() - priorBytes + bytes;
    const ceiling = this.coResidencyBytes();
    if (this.enforced && ceiling < this.budgetBytes && wouldCommit > ceiling) {
      const clause = '(co-residency ceiling — RAM spillover off)';
      return `budget exhausted: would commit ${wouldCommit} against ${ceiling} ${clause}`;
    }
    return `budget exhausted: would commit ${wouldCommit} against ${this.budgetBytes}`;
  }

  release(key: EngineKey): void {
    const prior = this.reservations.get(key);
    if (prior === undefined) return;
    this.reservations.delete(key);
    log.debug(`release ${key} (-${prior}, committed ${this.committedBytes()}/${this.budgetBytes})`);
  }

  /** Sum of all current reservations. */
  committedBytes(): number {
    let sum = 0;
    for (const v of this.reservations.values()) sum += v;
    return sum;
  }

  /** Fast (on-accelerator) memory for this host — see {@link CapacityBudget.fastBytes}. */
  fastBudgetBytes(): number {
    const auto = this.autoBudget();
    // An explicit budget can only lower what we'll put on the accelerator,
    // never raise the card's capacity.
    return this.enforced ? Math.min(auto.fastBytes, this.budgetBytes) : auto.fastBytes;
  }

  /** Snapshot used by the UX status endpoint and tests. */
  committed(): CapacityCommitted {
    const auto = this.autoBudget();
    return {
      budgetBytes: this.budgetBytes,
      committedBytes: this.committedBytes(),
      enforced: this.enforced,
      systemRamBytes: this.systemRamBytes,
      autoBudgetBytes: auto.budgetBytes,
      overridden: this.explicitBudgetBytes !== null,
      pools: {
        kind: auto.kind,
        vramBytes: auto.vramBytes,
        ramShareBytes: auto.ramShareBytes,
        fastBytes: auto.fastBytes,
      },
      ramSpillover: {
        allowed: this.ramSpilloverAllowed(),
        auto: autoAllowRamSpillover(auto),
        overridden: this.explicitAllowRamSpillover !== null,
        coResidencyBytes: this.coResidencyBytes(),
      },
      byKey: [...this.reservations.entries()]
        .map(([key, bytes]) => ({ key, bytes }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  }

  /**
   * Fallback estimate when a catalog entry lacks `residentBytes`.
   * Used by callers building reservation requests from
   * `approxSizeBytes`. Multipliers reflect typical working-set
   * footprint vs. on-disk size at default context.
   *
   * llama.cpp at Q4_K_M with 8K ctx: ~1.20 × on-disk.
   * MLX at 4bit with 8K ctx: ~1.30 × on-disk (KV grows faster).
   *
   * ds4 is special: it streams MoE experts from SSD, so its resident
   * working set is bounded by the configured expert-cache budget + KV +
   * non-routed weights — NOT the full on-disk weight size. The catalog
   * `residentBytes` is authoritative for ds4; this fallback only caps at a
   * conservative streaming working set so a 64GB box is never told an
   * 87GB DeepSeek-V4 model "can't fit" (which is the whole point of ds4).
   */
  static estimateResidentBytes(engine: LocalProviderName, approxSizeBytes: number): number {
    if (engine === 'ds4') {
      const DS4_STREAMING_RESIDENT_FALLBACK = 48 * 1024 ** 3;
      return Math.min(approxSizeBytes, DS4_STREAMING_RESIDENT_FALLBACK);
    }
    const mult = engine === 'mlx' ? 1.3 : 1.2;
    return Math.round(approxSizeBytes * mult);
  }
}

const GIB = 1024 ** 3;

/**
 * Demand-shaped default concurrent-slot count for a SUPERVISED local engine —
 * llama-server's `--parallel N` or the MLX server's `--max-concurrency N` —
 * keyed on total system RAM. A single-user desktop rarely has more than a
 * couple of genuinely-concurrent turns, and every idle slot still reserves a
 * full context window of KV cache, so these stay modest. Returns 1 under
 * 16 GB (≈ batching off). For llama.cpp the per-model memory ceiling
 * ({@link llamaCppSlotCeiling}) clamps further on tight-RAM + big-model
 * combos; an explicit `providerConcurrency[engine]` config overrides verbatim.
 */
/**
 * RECLAIMABLE-aware free RAM. `os.freemem()` reports truly-free pages
 * only: on macOS, file-backed cache and purgeable memory count as "used"
 * even though the kernel hands them back on demand — and a just-exited
 * llama engine's mmap'd weights ARE file-backed cache, so freemem()
 * reads a few GB on a 64 GB box right after any model ran. Wild-caught
 * 2026-08-04: the context memory-clamp saw "~6.6 GB available", floored
 * gemma4-31b to 8,192 ctx, and all 11 trials died on context overflow —
 * on a machine with >40 GB actually reclaimable. Linux freemem() has the
 * same free-vs-MemAvailable trap.
 *
 * darwin: vm_stat free+inactive+speculative+purgeable+file-backed.
 * linux: /proc/meminfo MemAvailable. Fallback: freemem().
 */
export function availableSystemRamBytes(): number {
  // vm_stat categories overlap (file-backed pages span active+inactive),
  // so the raw sum can exceed physical RAM; cap at 90% of totalmem — the
  // consumers already hold back their own OS reserves on top.
  const cap = totalmem() * 0.9;
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 3_000 });
      const parsed = parseVmStatAvailableBytes(out);
      if (parsed !== null) return Math.max(Math.min(parsed, cap), freemem());
    } else if (process.platform === 'linux') {
      const parsed = parseMeminfoAvailableBytes(readFileSync('/proc/meminfo', 'utf8'));
      if (parsed !== null) return Math.max(Math.min(parsed, cap), freemem());
    }
  } catch {
    // Probe failure falls through to the conservative number.
  }
  return freemem();
}

/** Pure vm_stat parser (exported for tests). Returns null when the output
 *  doesn't look like vm_stat. */
export function parseVmStatAvailableBytes(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(page) || page <= 0) return null;
  const count = (label: string): number => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  const pages =
    count('Pages free') +
    count('Pages inactive') +
    count('Pages speculative') +
    count('Pages purgeable') +
    count('File-backed pages');
  if (pages <= 0) return null;
  return pages * page;
}

/** Pure /proc/meminfo parser (exported for tests). */
export function parseMeminfoAvailableBytes(text: string): number | null {
  const m = /MemAvailable:\s+(\d+)\s*kB/.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

export function defaultLocalEngineSlots(systemRamBytes: number = totalmem()): number {
  const gb = systemRamBytes / GIB;
  if (gb < 16) return 1;
  if (gb < 32) return 2;
  if (gb < 64) return 3;
  return 4;
}

/**
 * Conservative estimate of the KV-cache bytes ONE slot needs at a given
 * per-turn context window. We have no model attention-architecture metadata
 * (layers / KV-heads / head-dim) anywhere in the app, so we scale off the
 * on-disk weights size — calibrated to a measured anchor (a 26B Q4_K_M
 * Gemma uses ~2 GB of q8_0 KV at 65K ctx ≈ 30 KB/token) and biased ~1.3×
 * high so we under-provision slots rather than risk OOM. Clamped to a sane
 * per-token band so tiny models don't round to ~0 and giant MoE weights
 * don't push the estimate far past reality.
 */
export function estimatePerSlotKvBytes(opts: {
  perTurnCtxTokens: number;
  weightsBytes: number;
  kvCacheType?: string;
}): number {
  const KB = 1024;
  // f16 KV bytes/token per byte of (quantized) on-disk weights. ~1.3× the
  // measured Gemma-26B anchor (~3.7e-6) → conservative.
  const KV_RATIO_F16 = 5e-6;
  const perTokenF16 = Math.min(400 * KB, Math.max(40 * KB, opts.weightsBytes * KV_RATIO_F16));
  const kvType = opts.kvCacheType ?? 'q8_0';
  const quant = kvType.startsWith('q4')
    ? 0.3
    : kvType.startsWith('q8')
      ? 0.55
      : kvType === 'f32'
        ? 2
        : 1; // f16 / unknown → full
  return Math.round(opts.perTurnCtxTokens * perTokenF16 * quant);
}

/**
 * Fraction of the post-weights budget held back from KV-slot accounting to
 * cover what {@link estimatePerSlotKvBytes} doesn't: per-wave prefill/compute
 * activation buffers (prefill_step_size × batch × model dims), the framework's
 * own scratch, and estimator error. Without this reserve a model that "just
 * fits" N KV slots aborts the moment N concurrent prefills allocate their
 * compute buffers on top of resident KV — the qwen3.6-27b-q8 Metal OOM. A
 * flat 20% is deliberately blunt: the per-slot KV estimate is itself coarse,
 * so precision here buys nothing; a margin that survives a bad guess does.
 */
const LOCAL_ENGINE_COMPUTE_HEADROOM = 0.2;

/**
 * Bytes left for KV + compute after resident weights and any co-resident
 * models. Negative when the model barely fits (or doesn't) — callers clamp.
 * Shared so the slot COUNT ({@link localEngineSlotCeiling}) and the engine's
 * own prompt-cache budget can be sized against the SAME number instead of
 * drifting apart (a fat prompt cache holding idle-session KV was a
 * co-conspirator in the 27B Metal OOM, not just the concurrent slots).
 */
export function localEngineKvBudgetBytes(opts: {
  engine: LocalProviderName;
  budgetBytes: number;
  weightsBytes: number;
  committedOtherBytes?: number;
}): number {
  const weightsResident = CapacityBroker.estimateResidentBytes(opts.engine, opts.weightsBytes);
  return opts.budgetBytes - (opts.committedOtherBytes ?? 0) - weightsResident;
}

/**
 * Max concurrent slots that fit the model budget: resident weights +
 * N × per-slot KV + a compute-headroom reserve ≤ budget. Always ≥ 1 — if even
 * one slot's KV doesn't fit, that's the broker's job to deny the whole spawn;
 * our job is only the slot COUNT given the model loads. `committedOtherBytes`
 * subtracts co-resident model reservations (default 0 = primary/only model).
 *
 * `engine` drives the resident-weights multiplier (MLX's f16 KV + working set
 * runs heavier than llama.cpp's — see {@link CapacityBroker.estimateResidentBytes}).
 * Pass the ACTUAL `kvCacheType` the engine will run: MLX defaults to f16 (no
 * `--kv-bits`), so omitting it or passing a q8 type here silently under-counts
 * KV by ~1.8× and over-slots — exactly the trap the MLX path fell into.
 */
export function localEngineSlotCeiling(opts: {
  engine: LocalProviderName;
  budgetBytes: number;
  weightsBytes: number;
  perTurnCtxTokens: number;
  kvCacheType?: string;
  committedOtherBytes?: number;
}): number {
  const perSlotKv = estimatePerSlotKvBytes({
    perTurnCtxTokens: opts.perTurnCtxTokens,
    weightsBytes: opts.weightsBytes,
    ...(opts.kvCacheType !== undefined ? { kvCacheType: opts.kvCacheType } : {}),
  });
  if (perSlotKv <= 0) return 1;
  const freeForKv = localEngineKvBudgetBytes(opts);
  const usableForKv = freeForKv * (1 - LOCAL_ENGINE_COMPUTE_HEADROOM);
  return Math.max(1, Math.floor(usableForKv / perSlotKv));
}

/**
 * llama.cpp slot ceiling — thin wrapper over {@link localEngineSlotCeiling}.
 * Retained for existing callers/tests; new engine paths call the generic form
 * with their own `engine` + `kvCacheType`.
 */
export function llamaCppSlotCeiling(opts: {
  budgetBytes: number;
  weightsBytes: number;
  perTurnCtxTokens: number;
  kvCacheType?: string;
  committedOtherBytes?: number;
}): number {
  return localEngineSlotCeiling({ engine: 'llama-cpp', ...opts });
}

/**
 * Physical memory held back from the live-RAM half of the context clamp:
 * the OS, the desktop shell, and whatever the user is actually doing.
 * Deliberately small — `freeSystemRamBytes` is already net of everything
 * resident, so this only guards against the engine consuming the last
 * gigabytes and pushing the machine into the pagefile.
 */
const CTX_CLAMP_OS_RESERVE_BYTES = 2 * GIB;

/** Never clamp a turn's working window below this — sessions compact, tools
 * cap their output, and small-context failure modes are well handled; a
 * machine paging itself to death is not. */
const CTX_CLAMP_FLOOR_TOKENS = 8_192;

export interface CtxMemoryClampInput {
  /** The per-turn context the launch wants (`effectiveNumCtx`). */
  requestedPerTurnCtxTokens: number;
  /** `--parallel` slot count; total KV is per-turn ctx × slots. */
  slots: number;
  /**
   * KV bytes per token for ONE slot at the dtype the engine will actually
   * run. Pass the exact GGUF-derived figure when the model header is
   * readable (`estimateKvReserveBytes(...) / ctx`) — the weights-scaled
   * heuristic underestimates models with outsized attention geometry by
   * up to ~10× (a Gemma-12B at f16 KV is ~380 KB/token against the
   * heuristic's 40 KB), and that gap is exactly how a 6.7 GB model became
   * a 25 GB process on a 32 GB machine.
   */
  kvBytesPerToken: number;
  /** Resident weight footprint (post-multiplier — see estimateResidentBytes). */
  weightsResidentBytes: number;
  /** Admission budget for the resident set (broker or auto-derived). */
  budgetBytes: number;
  /** Reservations other resident models already hold. */
  committedOtherBytes?: number;
  /** Live free physical RAM (`os.freemem()`) at launch time. */
  freeSystemRamBytes: number;
  /**
   * Usable VRAM on a discrete card; MUST be 0 on unified/shared-pool
   * hosts, where the "VRAM" is the same physical RAM `freeSystemRamBytes`
   * measures and adding it would double-count. `computeCapacityBudget`
   * already reports `vramBytes: 0` for those hosts — pass its value.
   */
  vramBytes: number;
  minPerTurnCtxTokens?: number;
}

export interface CtxMemoryClampResult {
  perTurnCtxTokens: number;
  clamped: boolean;
  /** Human-readable rationale, set only when clamped. */
  reason: string | null;
}

/**
 * Clamp the per-turn context window so the engine's projected footprint —
 * resident weights plus total KV plus the compute-headroom reserve — fits
 * BOTH the capacity budget and what the machine can actually give right
 * now (live free RAM + discrete VRAM).
 *
 * This is the missing admission check behind the 2026-08-03 incident: the
 * slot ceiling sizes the slot COUNT and the broker admits WEIGHTS, but
 * nothing asked whether one slot at the requested context fit at all.
 * A 64K-token default on an f16-KV model sailed through both and put a
 * ~19 GB KV cache into system RAM. Clamping context degrades gracefully
 * (sessions compact sooner); paging does not degrade at all — it takes
 * the whole desktop with it.
 *
 * Never clamps below the floor: if even the floor doesn't fit, the engine
 * still launches at the floor and the existing OOM/recovery paths own the
 * outcome. Returns multiples of 1024 for tidy engine arguments.
 */
export function clampCtxTokensForMemory(input: CtxMemoryClampInput): CtxMemoryClampResult {
  const requested = input.requestedPerTurnCtxTokens;
  const floor = Math.max(1, input.minPerTurnCtxTokens ?? CTX_CLAMP_FLOOR_TOKENS);
  const slots = Math.max(1, input.slots);
  if (!(input.kvBytesPerToken > 0) || requested <= floor) {
    return { perTurnCtxTokens: requested, clamped: false, reason: null };
  }
  const committedOther = Math.max(0, input.committedOtherBytes ?? 0);
  const budgetCap = input.budgetBytes - committedOther;
  const liveCap =
    Math.max(0, input.vramBytes) +
    Math.max(0, input.freeSystemRamBytes - CTX_CLAMP_OS_RESERVE_BYTES);
  const cap = Math.min(budgetCap, liveCap);
  const kvAllowance = (cap - input.weightsResidentBytes) * (1 - LOCAL_ENGINE_COMPUTE_HEADROOM);
  const maxTotalTokens = kvAllowance > 0 ? kvAllowance / input.kvBytesPerToken : 0;
  const maxPerTurn = Math.floor(maxTotalTokens / slots / 1024) * 1024;
  const clampedTo = Math.max(floor, Math.min(requested, maxPerTurn));
  if (clampedTo >= requested) {
    return { perTurnCtxTokens: requested, clamped: false, reason: null };
  }
  const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
  const kvAtRequested = requested * slots * input.kvBytesPerToken;
  const kvAtClamped = clampedTo * slots * input.kvBytesPerToken;
  return {
    perTurnCtxTokens: clampedTo,
    clamped: true,
    reason:
      `context clamped ${requested} → ${clampedTo} tokens/turn (${slots} slot${slots === 1 ? '' : 's'}): ` +
      `weights ~${gb(input.weightsResidentBytes)} + KV at the requested context ~${gb(kvAtRequested)} ` +
      `exceeds available memory ~${gb(Math.max(0, cap))} ` +
      `(budget ${gb(budgetCap)}, live free RAM ${gb(Math.max(0, input.freeSystemRamBytes))}` +
      `${input.vramBytes > 0 ? ` + VRAM ${gb(input.vramBytes)}` : ''}` +
      `${committedOther > 0 ? `, ${gb(committedOther)} held by other models` : ''}); ` +
      `KV now ~${gb(kvAtClamped)}. Sessions compact sooner instead of the machine paging.`,
  };
}
