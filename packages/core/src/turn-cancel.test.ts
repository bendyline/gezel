import { describe, expect, it } from 'vitest';
import {
  TURN_CANCEL_MESSAGES,
  isTurnCancelledMessage,
  turnCancelledMessage,
} from './turn-cancel.js';

describe('turn cancellation copy', () => {
  it('names the cause rather than the call stack', () => {
    expect(turnCancelledMessage('user-stop')).toBe('You stopped this turn.');
    expect(turnCancelledMessage('service-restart')).toBe(
      'Gezel shut down while this turn was still running.',
    );
    for (const message of Object.values(TURN_CANCEL_MESSAGES)) {
      expect(message).not.toMatch(/caller/i);
    }
  });

  it('falls back to the unspecified wording', () => {
    expect(turnCancelledMessage()).toBe(TURN_CANCEL_MESSAGES.unspecified);
    expect(turnCancelledMessage(null)).toBe(TURN_CANCEL_MESSAGES.unspecified);
  });

  it('recognizes every message it writes, tagged or bare', () => {
    for (const message of Object.values(TURN_CANCEL_MESSAGES)) {
      expect(isTurnCancelledMessage(message)).toBe(true);
      expect(isTurnCancelledMessage(`[Mac AI] ${message}`)).toBe(true);
    }
  });

  it('still recognizes sessions written with the old provider wording', () => {
    // Persisted on disk forever; the detector gates the "Report error on
    // GitHub…" link, which must stay hidden for those turns too.
    expect(isTurnCancelledMessage('[Mac AI] turn cancelled by caller')).toBe(true);
    expect(isTurnCancelledMessage('[llama-cpp] turn canceled by caller')).toBe(true);
  });

  it('does not swallow genuine failures', () => {
    expect(isTurnCancelledMessage('[Mac AI] the on-device engine dropped the connection')).toBe(
      false,
    );
    expect(isTurnCancelledMessage('')).toBe(false);
    expect(isTurnCancelledMessage(undefined)).toBe(false);
  });
});
