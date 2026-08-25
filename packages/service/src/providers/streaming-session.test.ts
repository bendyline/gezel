import { describe, expect, it } from 'vitest';
import {
  type EnginePhaseEvent,
  type EngineStatsEvent,
  StreamingSessionBase,
  type TurnStatsEvent,
} from './streaming-session.js';
import type { TurnUsage } from './types.js';

/**
 * Concrete subclass exposing the protected surface. `clearHandlers` runs on
 * every provider's `disconnect()`, so a channel missing from it keeps its
 * subscribers — and their captured `sessionId` closures — alive for the life
 * of the process.
 */
class TestSession extends StreamingSessionBase {
  clear(): void {
    this.clearHandlers();
  }

  emitAll(): void {
    this.emitDelta('d');
    this.emitReasoningDelta('r');
    this.emitUsage({} as TurnUsage);
    this.emitWirePulse();
    this.emitToolArgsDelta('t', 'a');
    this.emitIntent('i');
    this.emitHeartbeat('h');
    this.emitWarning('w');
    this.emitEnginePhase({} as EnginePhaseEvent);
    this.emitTurnStats({} as TurnStatsEvent);
    this.emitEngineStats({} as EngineStatsEvent);
  }
}

/**
 * Every `on*` subscription method on the base class. Kept exhaustive on
 * purpose: a new channel added without a matching `clearHandlers()` line
 * should fail here rather than leak silently.
 */
const CHANNELS = [
  'onDelta',
  'onReasoningDelta',
  'onUsage',
  'onWirePulse',
  'onToolArgsDelta',
  'onIntent',
  'onHeartbeat',
  'onWarning',
  'onEnginePhase',
  'onTurnStats',
  'onEngineStats',
] as const;

describe('StreamingSessionBase — clearHandlers', () => {
  it('covers every subscription channel the class exposes', () => {
    const session = new TestSession();
    const fired: string[] = [];
    for (const channel of CHANNELS) {
      (session[channel] as (h: () => void) => () => void)(() => fired.push(channel));
    }

    session.emitAll();
    expect(new Set(fired)).toEqual(new Set(CHANNELS));

    fired.length = 0;
    session.clear();
    session.emitAll();
    expect(fired).toEqual([]);
  });

  it('lists every on* method of the base class in CHANNELS', () => {
    const declared = Object.getOwnPropertyNames(StreamingSessionBase.prototype).filter((name) =>
      name.startsWith('on'),
    );
    expect(new Set(declared)).toEqual(new Set(CHANNELS));
  });

  it('unsubscribes a single handler without disturbing the others', () => {
    const session = new TestSession();
    const fired: string[] = [];
    const off = session.onReasoningDelta(() => fired.push('reasoning'));
    session.onDelta(() => fired.push('delta'));

    off();
    session.emitAll();
    expect(fired).toEqual(['delta']);
  });
});
