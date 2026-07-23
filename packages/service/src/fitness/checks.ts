/**
 * Pure check-building for the model fitness probe (the proeve) —
 * product twin of the eval harness's `buildPreflightChecks`
 * (evals/src/preflight.ts). Same philosophy: every check is computed
 * from plain evidence so the whole verdict matrix is unit-testable
 * without spawning anything.
 *
 * Differences from the eval preflight, deliberate:
 * - No `profileResolution` check. That one greps the daemon log for
 *   tuning-trace lines to catch a HARNESS-side failure mode (an eval
 *   daemon running from a stale service dist that silently drops
 *   requested profiles). In-process resolution can't drift that way.
 * - `contextFit` is new: the eval gets context failures for free as
 *   trial failures; the product needs the static check up front.
 */

import type { ModelFitnessRecord } from '@bendyline/gezel';

/** Below this decode rate agentic work degrades into stall territory. */
export const DEFAULT_FITNESS_MIN_TPS = 3;

/**
 * Launch budgets at or above 2^30 are "unbounded" sentinels
 * (llama-server's default is Int32.MAX = 2147483647) — the
 * reason-forever failure mode the eval preflight guards against.
 */
export const UNBOUNDED_REASONING_THRESHOLD = 2 ** 30;

/**
 * Floor for a workable agentic context: the system prompt + tools
 * block runs 4-8K tokens before the user's ask, and the mid-loop
 * compaction machinery starts fighting for air below ~16K.
 */
export const FITNESS_MIN_CONTEXT_TOKENS = 16_384;

export function fitnessMinTps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GEZEL_FITNESS_MIN_TPS;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_FITNESS_MIN_TPS;
}

/** Marker the probe asks the model to write; matched leniently. */
export const PROBE_MARKER_RE = /proeve/i;

/** The single synthetic tool the probe advertises. Never executed. */
export const PROBE_TOOL_NAME = 'write_file';

export interface FitnessEvidence {
  /** Set when the engine/pool/session never came up. */
  spawnError?: string;
  /**
   * First captured external tool call from the tool turn, or null when
   * the model produced no call. `undefined` means the tool turn never
   * ran (earlier failure).
   */
  toolCall?: { name: string; argumentsJson: string } | null;
  /** Assistant prose from the tool turn — evidence for the failure detail. */
  toolTurnText?: string;
  /** Set when the tool turn itself threw (timeout, engine error). */
  toolTurnError?: string;
  /** Measured decode t/s from the generation turn, or null when unmeasured. */
  genTokensPerSec: number | null;
  /** Set when the generation turn threw (timeout, engine error). */
  generationError?: string;
  /** Manifest `thinkingBudget` resolved for launch; undefined = none authored. */
  reasoningBudget?: number;
  /** The probe saw `<think>`-style reasoning in either turn. */
  observedThinking: boolean;
  /** min(installed GGUF ctx, launch numCtx); undefined when unknown. */
  effectiveContextTokens?: number;
  minGenTokensPerSec: number;
}

export function buildFitnessChecks(ev: FitnessEvidence): {
  checks: ModelFitnessRecord['checks'];
  admitted: boolean;
} {
  const spawn = ev.spawnError
    ? { ok: false, detail: ev.spawnError }
    : { ok: true, detail: 'engine spawned and served the probe session' };

  const notReached = { ok: false, detail: 'not reached — an earlier probe stage failed' };

  const throughput = ev.spawnError
    ? notReached
    : ev.generationError
      ? { ok: false, detail: `generation turn failed: ${ev.generationError}` }
      : ev.genTokensPerSec == null
        ? { ok: true, detail: 'decode rate not measured (no turn stats) — non-gating pass' }
        : ev.genTokensPerSec >= ev.minGenTokensPerSec
          ? {
              ok: true,
              detail: `decodes at ${ev.genTokensPerSec.toFixed(1)} t/s (floor ${ev.minGenTokensPerSec})`,
            }
          : {
              ok: false,
              detail: `decodes at ${ev.genTokensPerSec.toFixed(1)} t/s — below the ${ev.minGenTokensPerSec} t/s floor for agentic work`,
            };

  const toolRoundTrip =
    ev.spawnError || ev.generationError
      ? notReached
      : ev.toolTurnError
        ? { ok: false, detail: `tool turn failed: ${ev.toolTurnError}` }
        : buildToolRoundTripCheck(ev);

  const reasoningBudget = buildReasoningBudgetCheck(ev);

  const contextFit =
    ev.effectiveContextTokens == null
      ? { ok: true, detail: 'context window unknown — non-gating pass' }
      : ev.effectiveContextTokens >= FITNESS_MIN_CONTEXT_TOKENS
        ? {
            ok: true,
            detail: `${ev.effectiveContextTokens.toLocaleString()} tokens of context (floor ${FITNESS_MIN_CONTEXT_TOKENS.toLocaleString()})`,
          }
        : {
            ok: false,
            detail: `only ${ev.effectiveContextTokens.toLocaleString()} tokens of context — below the ${FITNESS_MIN_CONTEXT_TOKENS.toLocaleString()}-token floor agentic tool loops need`,
          };

  const checks = { spawn, toolRoundTrip, throughput, reasoningBudget, contextFit };
  const admitted =
    spawn.ok && toolRoundTrip.ok && throughput.ok && reasoningBudget.ok && contextFit.ok;
  return { checks, admitted };
}

function buildToolRoundTripCheck(ev: FitnessEvidence): { ok: boolean; detail: string } {
  const call = ev.toolCall;
  if (!call) {
    const head = (ev.toolTurnText ?? '').slice(0, 160).replace(/\s+/g, ' ').trim();
    return {
      ok: false,
      detail: `model produced no tool call when asked to call ${PROBE_TOOL_NAME}${head ? ` — replied with prose instead: "${head}"` : ''}`,
    };
  }
  if (call.name !== PROBE_TOOL_NAME) {
    return {
      ok: false,
      detail: `model called "${call.name}" instead of ${PROBE_TOOL_NAME}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsJson);
  } catch {
    return {
      ok: false,
      detail: `model called ${PROBE_TOOL_NAME} with unparseable arguments: ${call.argumentsJson.slice(0, 120)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      detail: `model called ${PROBE_TOOL_NAME} with non-object arguments`,
    };
  }
  // Lenient marker match on the whole args string — small models
  // sometimes put the marker in the path, add prose around the call,
  // or vary the casing. The capability under test is "emits a
  // well-formed call to the advertised tool", not exact-string echo.
  if (!PROBE_MARKER_RE.test(call.argumentsJson)) {
    return {
      ok: false,
      detail: `model called ${PROBE_TOOL_NAME} but the arguments carry no trace of the requested content`,
    };
  }
  return {
    ok: true,
    detail: `model emitted a well-formed ${PROBE_TOOL_NAME} call (${call.argumentsJson.length} bytes of args)`,
  };
}

function buildReasoningBudgetCheck(ev: FitnessEvidence): { ok: boolean; detail: string } {
  if (typeof ev.reasoningBudget === 'number') {
    if (ev.reasoningBudget >= UNBOUNDED_REASONING_THRESHOLD) {
      return {
        ok: false,
        detail: `reasoning budget ${ev.reasoningBudget} is the unbounded sentinel (>= 2^30) — the model can think forever`,
      };
    }
    return { ok: true, detail: `reasoning budget capped at ${ev.reasoningBudget} tokens` };
  }
  if (ev.observedThinking) {
    return {
      ok: false,
      detail:
        'model emits thinking but its manifest authors no thinkingBudget cap — launch runs unbounded (-1) and hard prompts can reason forever',
    };
  }
  return { ok: true, detail: 'no thinking observed; no budget needed' };
}
