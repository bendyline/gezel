import { arch, platform, totalmem } from 'node:os';

const GIB = 1024 ** 3;

/** Ceiling on the auto-derived SYSTEM-RAM share, however much RAM the host reports. */
const BUDGET_CAP_BYTES = 96 * GIB;

/** Above this, a discrete-GPU/CPU host is treated as workstation-tier. */
const HIGH_MEMORY_THRESHOLD_BYTES = 96 * GIB;

/**
 * Fraction of unified memory local engines may hold. Apple Silicon shares
 * one pool between CPU and GPU, so the split that protects a discrete-GPU
 * host from cramping the OS just strands capacity here: the weights sit in
 * the same RAM the fraction was reserving. macOS itself lets the GPU wire
 * roughly 75% (`iogpu.wired_limit_pct`), and our budget covers weights plus
 * KV plus scratch, so the working ceiling sits just under that.
 *
 * Deliberately not higher. The budget is also what
 * {@link localEngineSlotCeiling} sizes concurrent KV slots against, so
 * raising it buys more than a bigger model — past ~0.72 on a 64 GB Mac a
 * 27B-q8 at 32K f16 goes from serial to two slots, which is the exact
 * shape that aborted Metal (see the regression test of that name). Growing
 * the load ceiling should not silently grow peak concurrency; until those
 * two are decoupled, this fraction has to respect both.
 */
const UNIFIED_FRACTION = 0.7;

/**
 * Floor on what stays outside the budget on a unified host. A fraction
 * alone is wrong at the small end — 80% of a 16 GB Mac leaves 3.2 GB for
 * macOS, the Electron shell, and the renderer combined. The OS reserve is
 * roughly constant in absolute terms, not proportional, so express it that
 * way and let whichever bound is tighter win.
 */
const UNIFIED_OS_RESERVE_BYTES = 4 * GIB;

/**
 * Share of a discrete card's VRAM local engines may hold. The whole pool is
 * available in practice; the 5% margin covers the display framebuffer and
 * driver allocations. Same number `detectMemoryProfile` uses for the fast
 * budget it reports to the UI — these must not drift.
 */
const VRAM_USABLE_FRACTION = 0.95;

/**
 * A reported "VRAM" at or above this share of system RAM is a shared pool
 * (GB10 / DGX Spark, or an integrated GPU reporting host memory), not a
 * dedicated card. Adding it to the RAM share would double-count the same
 * bytes, so those hosts take the unified curve instead.
 */
const UNIFIED_VRAM_RATIO = 0.75;

/**
 * Last accelerator-memory figure `detectMemoryProfile` measured on this host,
 * or null when nothing has probed yet / no GPU memory figure was published.
 *
 * The probe is async (`nvidia-smi`, `llama-server --list-devices`) while the
 * budget is read from synchronous paths — the engine-slot sizing in
 * `buildLlamaCppProvider`, the MLX KV ceiling — that have no broker to ask.
 * Those callers used to see a RAM-only number and size a 24 GB card's slots
 * against 38 GB of system RAM. Publishing the probe here lets them read the
 * same shape the broker does, and a host that has not probed yet degrades to
 * exactly the old RAM-only behavior rather than to a wrong GPU number.
 */
let detectedGpuVramBytes: number | null = null;
let detectedGpuUnifiedMemory: boolean | undefined;

/**
 * Publish the measured accelerator pool. Called by `detectMemoryProfile`.
 *
 * `unifiedMemory` is deliberately separate from the byte count: equal-sized
 * VRAM and RAM are common on small discrete-GPU machines, so their ratio is
 * not enough to tell a GeForce from a genuinely shared GB10/iGPU pool.
 */
export function setDetectedGpuVramBytes(bytes: number | null, unifiedMemory?: boolean): void {
  detectedGpuVramBytes =
    typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  detectedGpuUnifiedMemory = unifiedMemory;
}

/** The published accelerator-memory figure, or null when none was measured. */
export function getDetectedGpuVramBytes(): number | null {
  return detectedGpuVramBytes;
}

/**
 * True when CPU and GPU share one physical memory pool, so a byte spent on
 * weights is a byte the OS cannot use. Apple Silicon is the case that
 * matters for this platform fallback. Integrated-GPU PCs are supplied as
 * `unifiedMemory: true` by the async memory profile instead.
 */
export function isUnifiedMemoryHost(): boolean {
  return platform() === 'darwin' && arch() === 'arm64';
}

/** Which pool (or pools) the auto-derived budget is drawn from. */
export type CapacityBudgetKind = 'unified' | 'discrete-gpu' | 'system-ram';

export interface CapacityBudget {
  /**
   * Total working set resident local engines may hold, summed across every
   * pool they can use. This is the admission ceiling — the number the broker
   * denies against.
   */
  budgetBytes: number;
  /**
   * The FAST pool inside that budget: usable VRAM on a discrete card, the
   * whole budget on unified / CPU hosts. Size KV slots and prompt caches
   * against this, not against {@link budgetBytes} — on a discrete card the
   * rest of the budget is system RAM that weights stream from, and putting
   * more KV there than the card holds is how a GPU OOMs.
   */
  fastBytes: number;
  /** Usable VRAM on a discrete card; 0 on unified / CPU-only hosts. */
  vramBytes: number;
  /** The system-RAM share of the budget. */
  ramShareBytes: number;
  kind: CapacityBudgetKind;
  /** True when `GEZEL_CAPACITY_BUDGET_GB` set the total. */
  overriddenByEnv: boolean;
}

export interface CapacityBudgetInput {
  systemRamBytes?: number;
  /**
   * Measured discrete-GPU VRAM, or null for none. Omit entirely to fall back
   * to the last published probe ({@link getDetectedGpuVramBytes}) — but only
   * when `unifiedMemory` is also omitted, so a caller that states the host
   * shape explicitly (every test does) stays deterministic.
   */
  gpuVramBytes?: number | null;
  unifiedMemory?: boolean;
}

/**
 * Resolve the memory a host can give resident local engines, per pool.
 *
 * Three shapes:
 *
 *   • **unified** — Apple Silicon, or a host whose reported VRAM is really
 *     the shared pool. One pool: {@link UNIFIED_FRACTION} of it, minus a flat
 *     {@link UNIFIED_OS_RESERVE_BYTES} floor.
 *
 *   • **discrete-gpu** — a real card. Its VRAM is memory the OS does not
 *     want back, so it is ADDED to the RAM share rather than replacing it:
 *     a 42 GB MoE on a 24 GB card streams its experts from system RAM while
 *     attention stays on the GPU, and a budget that saw only one pool refused
 *     it. Bounded by construction — VRAM absorbs at most `vramBytes`, so no
 *     admissible set of models can put more than `ramShareBytes` in RAM.
 *
 *   • **system-ram** — no GPU. The discrete curve's RAM share alone.
 *
 * `GEZEL_CAPACITY_BUDGET_GB` overrides the total, including the setting.
 */
export function computeCapacityBudget(input: CapacityBudgetInput = {}): CapacityBudget {
  const systemRamBytes = input.systemRamBytes ?? totalmem();
  // Reading the ambient probe is for callers that know nothing about the
  // host. One that passes `unifiedMemory` has already described it.
  const measuredVram =
    input.gpuVramBytes !== undefined
      ? input.gpuVramBytes
      : input.unifiedMemory === undefined
        ? detectedGpuVramBytes
        : null;
  const measuredUnifiedMemory =
    input.unifiedMemory !== undefined
      ? input.unifiedMemory
      : input.gpuVramBytes === undefined
        ? detectedGpuUnifiedMemory
        : undefined;
  const hasCard =
    typeof measuredVram === 'number' && Number.isFinite(measuredVram) && measuredVram > 0;
  const sharedPool = hasCard && (measuredVram as number) >= systemRamBytes * UNIFIED_VRAM_RATIO;
  const unified = measuredUnifiedMemory ?? (isUnifiedMemoryHost() || sharedPool);
  const discrete = hasCard && !unified;

  const highMemory = systemRamBytes >= HIGH_MEMORY_THRESHOLD_BYTES;
  const ramShareBytes = unified
    ? highMemory
      ? Math.min(Math.floor(systemRamBytes * 0.8), BUDGET_CAP_BYTES)
      : Math.max(
          0,
          Math.min(
            Math.floor(systemRamBytes * UNIFIED_FRACTION),
            systemRamBytes - UNIFIED_OS_RESERVE_BYTES,
            BUDGET_CAP_BYTES,
          ),
        )
    : Math.min(Math.floor(systemRamBytes * (highMemory ? 0.8 : 0.6)), BUDGET_CAP_BYTES);
  const vramBytes = discrete ? Math.floor((measuredVram as number) * VRAM_USABLE_FRACTION) : 0;

  const kind: CapacityBudgetKind = unified ? 'unified' : discrete ? 'discrete-gpu' : 'system-ram';
  const auto = ramShareBytes + vramBytes;

  const envBytes = envOverrideBytes();
  if (envBytes !== null) {
    return {
      budgetBytes: envBytes,
      fastBytes: discrete ? Math.min(vramBytes, envBytes) : envBytes,
      vramBytes,
      ramShareBytes: Math.max(0, envBytes - vramBytes),
      kind,
      overriddenByEnv: true,
    };
  }

  return {
    budgetBytes: auto,
    fastBytes: discrete ? vramBytes : auto,
    vramBytes,
    ramShareBytes,
    kind,
    overriddenByEnv: false,
  };
}

/**
 * The default answer to "may co-resident models spill into system RAM?" for
 * this host, when the user has expressed no preference. Only a discrete card
 * has two pools to choose between; unified and CPU-only hosts have one, so
 * there is nothing to spill *into* and the rule never binds.
 */
export function autoAllowRamSpillover(budget: Pick<CapacityBudget, 'kind' | 'vramBytes'>): boolean {
  if (budget.kind !== 'discrete-gpu') return true;
  // One intentionally offloaded model may still use the combined pool, but
  // automatic co-residency must stay within VRAM. Otherwise concurrency would
  // incorrectly treat system RAM as additional graphics memory.
  return false;
}

function envOverrideBytes(): number | null {
  const raw = process.env.GEZEL_CAPACITY_BUDGET_GB;
  if (!raw) return null;
  const gb = Number.parseFloat(raw);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  return Math.round(gb * GIB);
}

/**
 * Auto-detect budget for resident local-engine processes, combined —
 * the total of {@link computeCapacityBudget}. See that function for the
 * per-pool rules.
 *
 * The unified curve is more permissive than the discrete RAM share at the
 * 16–64 GB end. That is where the old shared 60% fraction denied models the
 * machine could actually hold — a 16 GB Mac was capped at 9.6 GiB, below any
 * 8B-class model at 8-bit. It also means a fully committed budget on a small
 * Mac will lean on compressed memory; the `localEngineMemoryGb` setting
 * (Settings → the engine pages) is the dial for owners who want that traded
 * either way.
 */
export function autoDetectBudgetBytes(
  systemRamBytes: number = totalmem(),
  opts: { unifiedMemory?: boolean; gpuVramBytes?: number | null } = {},
): number {
  return computeCapacityBudget({ systemRamBytes, ...opts }).budgetBytes;
}

/**
 * The FAST-memory ceiling for this host — usable VRAM on a discrete card,
 * the whole budget otherwise. KV slots, prompt caches, and anything else
 * that must live where the compute happens size against this.
 */
export function fastMemoryBudgetBytes(
  systemRamBytes: number = totalmem(),
  opts: { unifiedMemory?: boolean; gpuVramBytes?: number | null } = {},
): number {
  return computeCapacityBudget({ systemRamBytes, ...opts }).fastBytes;
}
