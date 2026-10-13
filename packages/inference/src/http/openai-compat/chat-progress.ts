import type { AppChatProgress } from '@bendyline/gezel/app-models';
import type { EnginePhaseEvent } from '@bendyline/gezel/local-loop';

function finite(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

/** Phase changes and at most four activity/counter updates per second. */
export function createChatProgressReporter(
  emit: (progress: AppChatProgress) => void,
  now: () => number = Date.now,
) {
  let current: AppChatProgress = {
    phase: 'starting',
    percent: null,
    outputTokens: null,
    tokensPerSecond: null,
  };
  let last: AppChatProgress | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let activityPhase: 'reasoning' | 'generating' | null = null;
  const flush = (force = false, activity = false) => {
    if (!activity && JSON.stringify(last) === JSON.stringify(current)) return;
    const at = now();
    if (!force && current.phase === last?.phase && at - lastAt < 250) return;
    last = { ...current };
    lastAt = at;
    emit(last);
  };
  return {
    start() {
      flush(true);
    },
    flush() {
      flush(true);
    },
    activity(phase: 'reasoning' | 'generating') {
      activityPhase = phase;
      current = { ...current, phase, percent: null };
      flush(false, true);
    },
    engine(event: EnginePhaseEvent) {
      let phase: AppChatProgress['phase'];
      if (event.engineQueue?.state === 'waiting' || event.engineQueue?.state === 'paused') {
        phase = 'queued';
      } else if (event.phase === 'generating') {
        phase = activityPhase ?? 'generating';
      } else if (
        event.phase === 'starting' ||
        event.phase === 'loading_model' ||
        event.phase === 'prefill'
      ) {
        phase = event.phase;
        activityPhase = null;
      } else {
        return;
      }
      const fraction = finite(event.progress, 1);
      const count = finite(event.outputTokens, Number.MAX_SAFE_INTEGER);
      current = {
        phase,
        percent:
          (phase === 'prefill' || phase === 'loading_model') && fraction !== null
            ? fraction * 100
            : null,
        outputTokens: count !== null && Number.isSafeInteger(count) ? count : current.outputTokens,
        tokensPerSecond: finite(event.tokensPerSec, 10_000_000) ?? current.tokensPerSecond,
      };
      flush(false, true);
    },
  };
}
