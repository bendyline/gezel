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
 * Speed bands for an admitted model, fastest first. The badge says how it
 * runs on *this* machine in plain English rather than naming the trial —
 * "proeve passed" told a user nothing about whether they would enjoy using
 * the model.
 */
const SPEED_BANDS: ReadonlyArray<{
  minTps: number;
  label: string;
  tier: FitnessBadgeTier;
  detail: string;
}> = [
  {
    minTps: 100,
    label: 'runs fast',
    tier: 'ok',
    detail: 'It decodes faster than you can read.',
  },
  {
    minTps: 30,
    label: 'runs well',
    tier: 'ok',
    detail: 'It decodes at a comfortable working speed.',
  },
  {
    minTps: 2,
    label: 'runs slow',
    tier: 'ok',
    detail: 'It works, but long answers and tool loops will take a while.',
  },
  {
    minTps: 0,
    label: 'runs, but too slow',
    tier: 'warn',
    detail: 'It is too slow on this machine for practical agentic work.',
  },
];

/**
 * `128` above 10, `8.9` below. Bands are picked from this rounded value, not
 * the raw one, so the label never reads "runs well (100 t/s)" at 99.6.
 */
function displayTps(tps: number): number {
  return tps >= 10 ? Math.round(tps) : Number(tps.toFixed(1));
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
  const tps = record.genTokensPerSec;
  if (tps == null) {
    return {
      tier: 'ok',
      label: 'runs (speed unknown)',
      detail: `${passed} Its decode speed was not measured.${softener}${ramCaveat(ramFit)}`,
    };
  }

  const shown = displayTps(tps);
  const band = SPEED_BANDS.find((b) => shown >= b.minTps) ?? SPEED_BANDS[SPEED_BANDS.length - 1]!;
  return {
    tier: band.tier,
    label: `${band.label} (${shown} t/s)`,
    detail: `${passed} ${band.detail}${softener}${ramCaveat(ramFit)}`,
  };
}
