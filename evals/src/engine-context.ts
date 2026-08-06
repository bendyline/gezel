/**
 * Granted-context extraction from a trial's daemon.log (Theme E / E4).
 *
 * The 64K context policy (`MIN_VIABLE_LOCAL_CONTEXT_TOKENS` in
 * packages/service/src/providers/native/capacity-broker.ts) is only as
 * real as our ability to observe it: the 2026-08-05 incident shipped
 * twelve gemma4-31b trials whose admission math said "12288 tokens" while
 * the engine launched at 65536 under the eval env bypass — and nothing in
 * result.json recorded either number. This module turns the launch-time
 * evidence that already lands in daemon.log into a structured record so
 * sweeps can assert the policy instead of grepping for it.
 *
 * Line shapes read here are service-owned; each has a contract pin in
 * engine-context.test.ts (same pattern as capacity-contract.test.ts):
 *
 * - `[llama-server] launch {json}` — packages/service/src/chat/manager.ts
 *   (`contextPerSlot` / `contextTotal` / `slots` / `kvCacheType`). The
 *   engine's actual grant; ground truth.
 * - `context clamped <req> → <granted> tokens/turn` — capacity-broker.ts
 *   `clampCtxTokensForMemory` reason string, logged when launch admission
 *   reduced the window.
 * - `with its required <n>-token working window` — capacity-broker.ts
 *   `formatContextCapacityDenial`, the loud refusal when even one slot
 *   cannot hold the model-aware minimum.
 * - `declining the --swa-full auto-default` — manager.ts, the Gemma
 *   full-cache decline that preserves the window instead of clamping it.
 */

export interface EngineContextClamp {
  requestedTokens: number;
  grantedTokens: number;
}

export interface EngineContextRecord {
  /** Per-slot context tokens from the LAST engine launch line — ground truth. */
  grantedPerSlotTokens?: number;
  /** Total context across slots from the same launch line. */
  totalTokens?: number;
  slots?: number;
  kvCacheType?: string;
  /** Model id the engine launched with (cross-check against the trial's model). */
  launchModel?: string;
  /** Engine launches observed in the log; >1 means the engine restarted mid-trial. */
  launches: number;
  /** Latest admission clamp observed (requested → granted tokens/turn). */
  clamp?: EngineContextClamp;
  /**
   * A clamp verdict exists but the engine launched at a DIFFERENT (higher)
   * context — the admission-bypass signature (e.g. `GEZEL_LLAMA_NUM_CTX`
   * forcing the window while the math said it doesn't fit). This is the
   * exact shape of the 2026-08-05 gemma4-31b Metal OOM.
   */
  clampBypassed?: boolean;
  /** The capacity broker refused a launch outright (minimum window unmet). */
  capacityDenied?: boolean;
  /** Gemma `--swa-full` auto-default declined to keep the full window. */
  swaFullDeclined?: boolean;
}

const LAUNCH_LINE = /\[llama-server\] launch (\{.*\})\s*$/;
const CLAMP_LINE = /context clamped (\d+) → (\d+) tokens\/turn/;
const DENIAL_LINE = /with its required [\d,]+-token working window/;
const SWA_DECLINE_LINE = /declining the --swa-full auto-default/;

/**
 * Parse a daemon.log's granted-context evidence. Returns null when the log
 * holds none (mock/cloud providers, MLX — whose launch line carries no
 * context yet — or a trial that died before engine spawn).
 */
export function extractEngineContext(daemonLog: string | null): EngineContextRecord | null {
  if (!daemonLog) return null;
  let launches = 0;
  let lastLaunch: Record<string, unknown> | null = null;
  let lastClamp: EngineContextClamp | null = null;
  let capacityDenied = false;
  let swaFullDeclined = false;
  for (const line of daemonLog.split('\n')) {
    const launch = LAUNCH_LINE.exec(line);
    if (launch?.[1]) {
      try {
        const payload = JSON.parse(launch[1]) as Record<string, unknown>;
        launches += 1;
        if (typeof payload.contextPerSlot === 'number') lastLaunch = payload;
      } catch {
        // A truncated or interleaved log line; skip rather than guess.
      }
      continue;
    }
    // Order matters: the Gemma decline warn EMBEDS the clamp reason as its
    // "Fit detail" — there the clamp describes the remedy the guard
    // rejected, not one that was applied, so it must not count as a clamp
    // (the 2026-08-06 rebaseline sweep read as 12 false "bypasses" before
    // this precedence existed).
    if (SWA_DECLINE_LINE.test(line)) {
      swaFullDeclined = true;
      continue;
    }
    const clamp = CLAMP_LINE.exec(line);
    if (clamp?.[1] && clamp[2]) {
      lastClamp = {
        requestedTokens: Number.parseInt(clamp[1], 10),
        grantedTokens: Number.parseInt(clamp[2], 10),
      };
      continue;
    }
    if (DENIAL_LINE.test(line)) capacityDenied = true;
  }
  if (launches === 0 && !lastClamp && !capacityDenied && !swaFullDeclined) return null;
  const granted =
    typeof lastLaunch?.contextPerSlot === 'number' ? lastLaunch.contextPerSlot : undefined;
  const record: EngineContextRecord = { launches };
  if (granted !== undefined) record.grantedPerSlotTokens = granted;
  if (typeof lastLaunch?.contextTotal === 'number') record.totalTokens = lastLaunch.contextTotal;
  if (typeof lastLaunch?.slots === 'number') record.slots = lastLaunch.slots;
  if (typeof lastLaunch?.kvCacheType === 'string') record.kvCacheType = lastLaunch.kvCacheType;
  if (typeof lastLaunch?.model === 'string') record.launchModel = lastLaunch.model;
  if (lastClamp) {
    record.clamp = lastClamp;
    if (granted !== undefined && granted > lastClamp.grantedTokens) record.clampBypassed = true;
  }
  if (capacityDenied) record.capacityDenied = true;
  if (swaFullDeclined) record.swaFullDeclined = true;
  return record;
}
