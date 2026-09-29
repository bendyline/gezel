import type { MobileEnginePhaseEvent } from '../schemas/mobile-provider.js';

const count = (value: number) => value.toLocaleString('en-US');

/**
 * The status-pill wording for a native phase, in the desktop engines'
 * words so a phone and a laptop describe the same work the same way.
 * Undefined when the event carries nothing beyond its phase name.
 */
export function mobileEnginePhaseDetail(
  event: Omit<MobileEnginePhaseEvent, 'requestId'>,
): string | undefined {
  const pct = event.progress === undefined ? undefined : Math.round(event.progress * 100);
  if (event.phase === 'loading_model')
    return pct === undefined ? 'Loading model into memory' : `Loading model weights (${pct}%)`;
  if (event.phase === 'prefill') {
    if (event.processedTokens !== undefined && event.promptTokens) {
      const progress = pct ?? Math.round((event.processedTokens / event.promptTokens) * 100);
      return `Processing prompt (${progress}% · ${count(event.processedTokens)} / ${count(event.promptTokens)} tokens)`;
    }
    return pct === undefined ? undefined : `Processing prompt (${pct}%)`;
  }
  return undefined;
}
