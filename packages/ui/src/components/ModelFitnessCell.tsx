import { composeFitnessBadge, fitnessThroughput } from '@bendyline/gezel';
import type { ModelFitnessEntry } from '@bendyline/gezel-client';

/**
 * The FITNESS column of a local-model table: the proeve badge, plus the
 * measured reading speed the badge label has no room for.
 *
 * Shared by all three engine managers so the column reads identically
 * whichever engine you are looking at. The badge itself is composed in core
 * ({@link composeFitnessBadge}) — this owns only presentation.
 *
 * The second line exists because decode speed alone is a half-answer on a
 * large model: a DwarfStar build streams routed experts from SSD and can
 * write at a comfortable rate while still taking a minute to *read* a long
 * prompt. That wait is what the user actually feels, so it goes on the row.
 *
 * When something went wrong, the badge's reason goes on the row too. "Fitness
 * check failed" on its own is unactionable, and the explanation was already
 * being computed — it just lived in a tooltip nobody thinks to hover.
 */

function displayRate(tokensPerSec: number): string {
  return tokensPerSec >= 10 ? Math.round(tokensPerSec).toLocaleString() : tokensPerSec.toFixed(1);
}

function displaySeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10 ? `${Number(seconds.toFixed(1))}s` : `${Math.round(seconds)}s`;
}

/**
 * A stale record's numbers describe weights that are no longer on disk, and
 * the badge already reads "not checked yet" — printing speeds under it would
 * contradict the badge. Everything else (including a check that is running
 * right now) keeps its last measurement on screen.
 */
function speedLine(entry: ModelFitnessEntry | undefined): { label: string; title: string } | null {
  if (!entry || entry.stale) return null;
  const speeds = fitnessThroughput(entry.record);
  if (!speeds || speeds.prefillTokensPerSec == null) return null;

  const rate = displayRate(speeds.prefillTokensPerSec);
  const prompt = speeds.evaluatedPromptTokens.toLocaleString();
  const took = speeds.ttftMs != null ? displaySeconds(speeds.ttftMs) : null;
  const derived = speeds.prefillSource === 'first-token';

  return {
    label: `prefill ${derived ? '~' : ''}${rate} t/s`,
    title: derived
      ? `Reading the ${prompt}-token check prompt took about ${took ?? 'a moment'} — roughly ${rate} tokens/sec. Measured from how long the model took to produce its first word, because this engine does not report its own prefill timing.`
      : `The engine read the ${prompt}-token check prompt at ${rate} tokens/sec${took ? `, ${took} before the first word of the answer` : ''}.`,
  };
}

export function ModelFitnessCell({
  entry,
  probing,
}: {
  entry: ModelFitnessEntry | undefined;
  probing: boolean;
}) {
  const badge = composeFitnessBadge({
    ...(entry
      ? {
          fitness: {
            record: entry.record,
            stale: entry.stale,
            hardwareChanged: entry.hardwareChanged,
          },
        }
      : {}),
    probing,
  });
  const speeds = speedLine(entry);

  return (
    <td className="model-fitness-table-cell">
      <div className="model-fitness-cell">
        <span
          className={`gz-status-pill model-fitness-badge${
            badge.tier === 'probing' ? ' model-fitness-badge--probing' : ''
          }${
            badge.tier === 'ok'
              ? ' gz-status-pill--ok'
              : badge.tier === 'warn'
                ? ' gz-status-pill--warn'
                : ''
          }`}
          title={badge.detail}
        >
          {badge.label}
        </span>
        {badge.reason && (
          <span className="muted small model-fitness-reason" title={badge.detail}>
            {badge.reason}
          </span>
        )}
        {speeds && (
          <span className="muted small model-fitness-speeds" title={speeds.title}>
            {speeds.label}
          </span>
        )}
      </div>
    </td>
  );
}

/**
 * The overflow-menu entry that runs the check. A record that exists but
 * could not run ('blocked') offers "Run", not "Re-run" — nothing was
 * measured, so there is nothing to re-do.
 */
export function fitnessMenuAction(
  entry: ModelFitnessEntry | undefined,
  probing: boolean,
  onRun: () => void,
): { label: string; checking: boolean; onRun: () => void } {
  return {
    label: probing
      ? 'Checking fitness…'
      : entry && !entry.stale && entry.record.status !== 'blocked'
        ? 'Re-run fitness check'
        : 'Run fitness check',
    checking: probing,
    onRun,
  };
}
