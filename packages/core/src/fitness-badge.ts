/**
 * Compose the static RAM-axis fit (`computeModelFit`) with a persisted
 * fitness record (the proeve result) into one display badge. Pure and
 * unit-tested; shared by the UI pills and any service consumer.
 *
 * Warnings never gate: the badge informs, selection stays possible
 * everywhere.
 */

import type { ModelFitResult } from './model-fit.js';
import type { ModelFitnessRecord } from './schemas/model-fitness.js';

export type FitnessBadgeTier = 'ok' | 'warn' | 'probing' | 'unknown';

export interface FitnessBadge {
  tier: FitnessBadgeTier;
  /** Short pill label. */
  label: string;
  /** Longer tooltip explanation. */
  detail: string;
}

export interface FitnessBadgeInput {
  /** Static RAM-axis fit, when known (browse and installed surfaces). */
  ramFit?: ModelFitResult;
  /** Persisted proeve result plus its read-time freshness flags. */
  fitness?: {
    record: ModelFitnessRecord;
    stale: boolean;
    hardwareChanged: boolean;
  };
  /** A probe for this model is currently queued or running. */
  probing?: boolean;
}

/**
 * Order matters: the first failing axis names the badge. Spawn first
 * (nothing else is meaningful if the engine never came up), then the
 * capability axes in the order a user can act on them.
 */
const CHECK_LABELS: ReadonlyArray<{
  key: keyof ModelFitnessRecord['checks'];
  label: string;
}> = [
  { key: 'spawn', label: 'did not start' },
  { key: 'toolRoundTrip', label: 'tool calls failed' },
  { key: 'throughput', label: 'slow decoding' },
  { key: 'reasoningBudget', label: 'unbounded reasoning' },
  { key: 'contextFit', label: 'small context' },
];

/**
 * Speed bands for an admitted model, fastest first. They determine severity
 * and the plain-language tooltip while the badge itself shows the two numbers
 * users experience: startup latency and loaded-context decode speed.
 */
const SPEED_BANDS: ReadonlyArray<{
  minTps: number;
  tier: FitnessBadgeTier;
  detail: string;
}> = [
  {
    minTps: 100,
    tier: 'ok',
    detail: 'It decodes faster than you can read.',
  },
  {
    minTps: 30,
    tier: 'ok',
    detail: 'It decodes at a comfortable working speed.',
  },
  {
    minTps: 2,
    tier: 'ok',
    detail: 'It works, but long answers and tool loops will take a while.',
  },
  {
    minTps: 0,
    tier: 'warn',
    detail: 'It is too slow on this machine for practical agentic work.',
  },
];

/**
 * `128` above 10, `8.9` below. Bands are picked from this rounded value, not
 * the raw one, so the displayed rate and its severity cannot disagree at a
 * rounding boundary.
 */
function displayTps(tps: number): number {
  return tps >= 10 ? Math.round(tps) : Number(tps.toFixed(1));
}

function displayDuration(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10 ? `${Number(seconds.toFixed(1))}s` : `${Math.round(seconds)}s`;
}

function displayContext(tokens: number): string {
  return tokens >= 1000
    ? `${Number((tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1))}K`
    : `${tokens}`;
}

function ramCaveat(ramFit: ModelFitResult | undefined): string {
  if (!ramFit || ramFit.tier === 'fits' || ramFit.tier === 'fits-offload') return '';
  return ` Memory fit: ${ramFit.label} — ${ramFit.detail}`;
}

export function composeFitnessBadge(input: FitnessBadgeInput): FitnessBadge {
  const { ramFit, fitness, probing } = input;

  if (probing) {
    return {
      tier: 'probing',
      label: 'checking fitness…',
      detail: 'A fitness check (proeve) is running against this model.',
    };
  }

  if (!fitness || fitness.stale) {
    return {
      tier: 'unknown',
      label: 'not checked yet',
      detail:
        (fitness?.stale
          ? 'The model changed since its last fitness check — run it again.'
          : 'No fitness check has run for this model yet.') + ramCaveat(ramFit),
    };
  }

  const { record, hardwareChanged } = fitness;
  const softener = hardwareChanged
    ? ' Hardware has changed since this check — consider re-running it.'
    : '';

  if (record.status === 'blocked') {
    return {
      tier: 'unknown',
      label: 'did not run',
      detail: `The fitness check could not run — the engine was busy serving other requests. Nothing is wrong with the model; run the check again in a moment.${softener}${ramCaveat(ramFit)}`,
    };
  }

  if (record.status === 'failed') {
    // Name the axis that actually failed. Reading `checks.spawn` blindly
    // reported "engine spawned and served the probe session" as the reason a
    // check failed, because spawn passes whenever the session was created —
    // and native engines start lazily, on the first turn.
    const cause = CHECK_LABELS.find((c) => !record.checks[c.key].ok);
    const detail = cause ? record.checks[cause.key].detail : record.checks.spawn.detail;
    return {
      tier: 'warn',
      label: 'fitness check failed',
      detail: `The fitness check could not complete: ${detail}${softener}${ramCaveat(ramFit)}`,
    };
  }

  if (record.status === 'deferred') {
    return {
      tier: 'unknown',
      label: 'check deferred',
      detail: `The automatic fitness check waited for memory headroom and gave up — run it manually.${ramCaveat(ramFit)}`,
    };
  }

  if (!record.admitted) {
    const failing = CHECK_LABELS.filter((c) => !record.checks[c.key].ok);
    const first = failing[0];
    const detail = failing.map((c) => record.checks[c.key].detail).join(' ');
    return {
      tier: 'warn',
      label: first?.label ?? 'fitness concerns',
      detail: detail + softener + ramCaveat(ramFit),
    };
  }

  const passed = 'It starts, calls tools, and answers.';
  const representative = record.representativeContext;
  const tps = representative ? representative.genTokensPerSec : record.genTokensPerSec;
  if (tps == null) {
    if (representative?.ttftMs != null) {
      const promptTokens = representative.promptTokens ?? representative.targetPromptTokens;
      return {
        tier: 'ok',
        label: `starts ~${displayDuration(representative.ttftMs)} · speed unknown`,
        detail: `${passed} With a representative ${displayContext(promptTokens)}-token prompt, first model output arrived in ${displayDuration(representative.ttftMs)}; decode speed was not measured.${softener}${ramCaveat(ramFit)}`,
      };
    }
    return {
      tier: 'ok',
      label: representative ? 'representative speed unknown' : 'short prompt · speed unknown',
      detail: representative
        ? `${passed} Its representative-context decode speed was not measured.${softener}${ramCaveat(ramFit)}`
        : `${passed} This older check did not measure representative-context performance; re-run it for realistic startup and decode timing.${softener}${ramCaveat(ramFit)}`,
    };
  }

  const shown = displayTps(tps);
  const band = SPEED_BANDS.find((b) => shown >= b.minTps) ?? SPEED_BANDS[SPEED_BANDS.length - 1]!;
  if (representative) {
    const observedPromptTokens = representative.promptTokens ?? representative.targetPromptTokens;
    const promptDetail = `With a representative ${displayContext(observedPromptTokens)}-token prompt`;
    const startDetail =
      representative.ttftMs != null
        ? `first model output arrived in ${displayDuration(representative.ttftMs)}`
        : 'time to first output was not measured';
    const prefillDetail =
      representative.promptTokensPerSec != null
        ? ` Prefill ran at ${displayTps(representative.promptTokensPerSec)} t/s.`
        : '';
    const cacheDetail =
      representative.cachedPromptTokens != null && representative.cachedPromptTokens > 0
        ? ` ${representative.cachedPromptTokens.toLocaleString()} prompt tokens came from cache.`
        : '';
    const shortDetail =
      record.shortPromptGenTokensPerSec != null
        ? ` Short-prompt decode was ${displayTps(record.shortPromptGenTokensPerSec)} t/s.`
        : '';
    return {
      tier: band.tier,
      label:
        representative.ttftMs != null
          ? `starts ~${displayDuration(representative.ttftMs)} · ${shown} t/s`
          : `${displayContext(observedPromptTokens)} context · ${shown} t/s`,
      detail: `${passed} ${promptDetail}, ${startDetail}, and decode ran at ${shown} t/s. ${band.detail}${prefillDetail}${cacheDetail}${shortDetail}${softener}${ramCaveat(ramFit)}`,
    };
  }
  return {
    tier: band.tier,
    label: `short prompt · ${shown} t/s`,
    detail: `${passed} This older check measured only short-prompt decode (${shown} t/s); re-run it for realistic startup and loaded-context timing. ${band.detail}${softener}${ramCaveat(ramFit)}`,
  };
}
