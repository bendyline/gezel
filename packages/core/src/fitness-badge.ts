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

  if (record.status === 'failed') {
    return {
      tier: 'warn',
      label: 'fitness check failed',
      detail: `The fitness check could not complete: ${record.checks.spawn.detail}${softener}${ramCaveat(ramFit)}`,
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

  const tps = record.genTokensPerSec != null ? ` · ${Math.round(record.genTokensPerSec)} t/s` : '';
  return {
    tier: 'ok',
    label: `proeve passed${tps}`,
    detail: `This model passed its fitness check: it starts, calls tools, and decodes at a workable speed.${softener}${ramCaveat(ramFit)}`,
  };
}
