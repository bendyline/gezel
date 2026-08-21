/**
 * Deadline sizing for the index-enrichment one-shots.
 *
 * The flat 120s summarize wall was written when every local enricher was a
 * dense 9-30B model decoding at 15-40 tok/s: a 2-3 sentence summary finished
 * in well under a minute, and the wall only ever fired on a genuine hang.
 * It stopped being true the moment a big MoE could be the enrich target. A
 * ds4-class model prefills at ~28 tok/s and decodes at ~3, so a 6000-char
 * file needs ~4 minutes of honest work — every summarize timed out at 120s,
 * retried three times, and the sweep produced nothing while occupying the
 * largest engine on the machine for six minutes per file.
 *
 * The fix is to stop expressing the deadline as a wall-clock constant and
 * derive it from the actual shape of the request — prefill this prompt,
 * decode that many tokens, at this model's measured rate. The constants
 * below are floors and ceilings on that estimate, not the estimate itself.
 *
 * Nothing here is a routing input: a slow model gets a longer deadline, not
 * a worse ranking. The one job is to bound the failure mode.
 */

import type { GezelConfig } from '@bendyline/gezel';
import { ModelFitnessRecordSchema, createLogger, modelFitnessKey } from '@bendyline/gezel';
import { MIN_ROUTING_GEN_TPS } from '../chat/model-routing.js';

const log = createLogger('enrich');

/**
 * Decode floor for a local model we have no measurement for. Tied to the
 * routing floor deliberately: models slower than this are dropped from
 * automatic routing entirely, so it is the slowest rate we ever knowingly
 * run — which makes it the right pessimistic assumption when sizing a
 * deadline, and the wrong one for anything else.
 *
 * Unmeasured is the common case, not the edge: a fitness probe is a real
 * engine spawn, so a model whose probe was deferred for capacity (exactly
 * what happens to the biggest model on the machine) has a record with
 * `genTokensPerSec: null`.
 */
const ASSUMED_GEN_TPS = MIN_ROUTING_GEN_TPS;

/**
 * Prefill floor for an unmeasured local model. Fitness records carry
 * `representativeContext.promptTokensPerSec` only for newer probes; the
 * measured spread runs from ~28 tok/s (284B MoE, 128 GB M-series) to ~500
 * (27B dense, same host), so the low end is what an unmeasured model has to
 * be assumed to be.
 */
const ASSUMED_PROMPT_TPS = 25;

/**
 * Fixed per-request overhead the token math doesn't see: engine admission,
 * a cold model load, KV cache lookup, and the queue wait that the one-shot
 * deadline explicitly includes.
 */
const SETUP_ALLOWANCE_MS = 60_000;

/** Estimates are estimates — a turn that runs 50% long is not a hang. */
const SAFETY_FACTOR = 1.5;

/** Rough chars-per-token for prompt sizing. Deliberately not a tokenizer. */
const CHARS_PER_TOKEN = 4;

export interface EnrichThroughput {
  promptTokensPerSec: number;
  genTokensPerSec: number;
  /** False when both rates are the pessimistic floors rather than a probe. */
  measured: boolean;
}

export interface EnrichBudget {
  /** Expected output allowance for the job, in tokens. */
  outputTokens: number;
  /** Today's constant — the estimate never lowers a deadline below it. */
  floorMs: number;
  /** Hard cap, so a bad estimate can't park an engine indefinitely. */
  ceilingMs: number;
}

/**
 * A 2-3 sentence summary is ~100 tokens of visible output, but the enrich
 * profile is `instruct` on models that still open a reasoning channel — the
 * observed spread is 200-500 total. Budget for the top of it.
 */
export const SUMMARIZE_BUDGET: EnrichBudget = {
  outputTokens: 512,
  floorMs: 120_000,
  ceilingMs: 600_000,
};

/** Reviews emit cliffs notes plus up to ten issues as JSON. */
export const REVIEW_BUDGET: EnrichBudget = {
  outputTokens: 1024,
  floorMs: 180_000,
  ceilingMs: 900_000,
};

/**
 * Measured decode/prefill rates for a local enrich target, from the fitness
 * probe records in `config.modelFitness`. Returns the pessimistic floors
 * (`measured: false`) when there is no usable measurement — a probe that
 * deferred, failed, or predates the representative-context evidence.
 *
 * Staleness is not checked. A stale rate is still far better evidence about
 * a model's order of magnitude than the floor, and the cost of being wrong
 * here is a deadline that is somewhat too long or too short, never a wrong
 * routing decision.
 */
export function resolveEnrichThroughput(
  config: Pick<GezelConfig, 'modelFitness'> | null | undefined,
  providerName: string,
  model: string,
): EnrichThroughput {
  const floors: EnrichThroughput = {
    promptTokensPerSec: ASSUMED_PROMPT_TPS,
    genTokensPerSec: ASSUMED_GEN_TPS,
    measured: false,
  };
  const raw = config?.modelFitness?.[modelFitnessKey(providerName, model)];
  if (!raw) return floors;
  const parsed = ModelFitnessRecordSchema.safeParse(raw);
  if (!parsed.success) return floors;
  const record = parsed.data;
  const rep = record.representativeContext;
  const gen = rep?.genTokensPerSec ?? record.genTokensPerSec;
  if (gen == null || gen <= 0) return floors;
  return {
    // The representative-context probe is the only source of a prefill rate;
    // an older record measured decode alone, so the floor stands in.
    promptTokensPerSec:
      rep?.promptTokensPerSec != null && rep.promptTokensPerSec > 0
        ? rep.promptTokensPerSec
        : ASSUMED_PROMPT_TPS,
    genTokensPerSec: gen,
    measured: true,
  };
}

/**
 * Deadline for one enrichment one-shot: prefill the prompt, decode the
 * output allowance, plus setup — scaled for estimate error and clamped to
 * the job's floor and ceiling. Never returns less than `floorMs`, so no
 * existing target's deadline shortens.
 */
export function enrichTimeoutMs(
  promptChars: number,
  throughput: EnrichThroughput,
  budget: EnrichBudget,
): number {
  const promptTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN);
  const prefillMs = (promptTokens / throughput.promptTokensPerSec) * 1000;
  const decodeMs = (budget.outputTokens / throughput.genTokensPerSec) * 1000;
  const estimate = (SETUP_ALLOWANCE_MS + prefillMs + decodeMs) * SAFETY_FACTOR;
  return Math.round(Math.min(budget.ceilingMs, Math.max(budget.floorMs, estimate)));
}

/** Deduped by resolved target — `buildEnrichDeps` runs once per project per tick. */
let lastBudgetLogged = '';

/**
 * One line per enrich TARGET describing the deadline it earned, so a timeout
 * in the log can be read against what the model was given rather than
 * against a constant that is no longer in the source.
 */
export function logEnrichBudget(
  providerName: string,
  model: string,
  throughput: EnrichThroughput,
  summarizeExampleMs: number,
): void {
  const signature = `${providerName}:${model}:${throughput.measured}:${summarizeExampleMs}`;
  if (signature === lastBudgetLogged) return;
  lastBudgetLogged = signature;
  const rate = throughput.measured
    ? `${throughput.genTokensPerSec.toFixed(1)} tok/s decode (measured)`
    : `${throughput.genTokensPerSec.toFixed(1)} tok/s decode (assumed — no fitness probe)`;
  log.info(
    `[enrich] target ${providerName}:${model} — ${rate}, ` +
      `summarize deadline ~${Math.round(summarizeExampleMs / 1000)}s for a full-size file`,
  );
}
