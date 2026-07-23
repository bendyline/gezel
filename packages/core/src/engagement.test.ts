import { describe, expect, it } from 'vitest';
import {
  type AIEngagementMode,
  type WorkshopTempo,
  getEngagementMode,
  getWorkshopTempo,
  isEngagementAllowed,
  isProactiveAllowed,
  isSchedulingAllowed,
  workshopTempoDefaults,
} from './engagement.js';

const MODES: AIEngagementMode[] = ['proactive', 'scheduled', 'reactive', 'off'];

describe('getEngagementMode', () => {
  it('defaults to proactive when unset', () => {
    expect(getEngagementMode({})).toBe('proactive');
    expect(getEngagementMode({ aiEngagementMode: undefined })).toBe('proactive');
  });
  it.each(MODES)('returns the explicit mode %s', (m) => {
    expect(getEngagementMode({ aiEngagementMode: m })).toBe(m);
  });
});

describe('isProactiveAllowed', () => {
  it('is only true for proactive', () => {
    expect(isProactiveAllowed({})).toBe(true);
    expect(isProactiveAllowed({ aiEngagementMode: 'proactive' })).toBe(true);
    expect(isProactiveAllowed({ aiEngagementMode: 'scheduled' })).toBe(false);
    expect(isProactiveAllowed({ aiEngagementMode: 'reactive' })).toBe(false);
    expect(isProactiveAllowed({ aiEngagementMode: 'off' })).toBe(false);
  });
});

describe('isSchedulingAllowed', () => {
  it('allows proactive and scheduled', () => {
    expect(isSchedulingAllowed({ aiEngagementMode: 'proactive' })).toBe(true);
    expect(isSchedulingAllowed({ aiEngagementMode: 'scheduled' })).toBe(true);
  });
  it('blocks reactive and off', () => {
    expect(isSchedulingAllowed({ aiEngagementMode: 'reactive' })).toBe(false);
    expect(isSchedulingAllowed({ aiEngagementMode: 'off' })).toBe(false);
  });
});

describe('isEngagementAllowed', () => {
  it('blocks only off', () => {
    expect(isEngagementAllowed({ aiEngagementMode: 'proactive' })).toBe(true);
    expect(isEngagementAllowed({ aiEngagementMode: 'scheduled' })).toBe(true);
    expect(isEngagementAllowed({ aiEngagementMode: 'reactive' })).toBe(true);
    expect(isEngagementAllowed({ aiEngagementMode: 'off' })).toBe(false);
    expect(isEngagementAllowed({})).toBe(true);
  });
});

const TEMPOS: WorkshopTempo[] = ['gezellig', 'bedrijvig', 'druk', 'dolle-boel'];

describe('getWorkshopTempo', () => {
  it('defaults to bedrijvig when unset', () => {
    expect(getWorkshopTempo({})).toBe('bedrijvig');
    expect(getWorkshopTempo({ workshopTempo: undefined })).toBe('bedrijvig');
  });
  it.each(TEMPOS)('returns the explicit tempo %s', (t) => {
    expect(getWorkshopTempo({ workshopTempo: t })).toBe(t);
  });
});

describe('workshopTempoDefaults', () => {
  it('orders rapid intervals from longest to shortest across tempos', () => {
    const rapids = TEMPOS.map((t) => workshopTempoDefaults(t).rapidIntervalMs);
    // gezellig > bedrijvig > druk > dolle-boel — each strictly smaller.
    for (let i = 0; i < rapids.length - 1; i++) {
      expect(rapids[i]).toBeGreaterThan(rapids[i + 1]!);
    }
  });

  it('bedrijvig matches the historical pre-tempo defaults', () => {
    const b = workshopTempoDefaults('bedrijvig');
    expect(b.rapidIntervalMs).toBe(5 * 60_000);
    expect(b.slowIntervalMs).toBe(6 * 60 * 60_000);
    expect(b.rapidAttemptsBeforeBackoff).toBe(3);
  });

  it('dolle-boel is under a minute so the joke tier actually feels like one', () => {
    expect(workshopTempoDefaults('dolle-boel').rapidIntervalMs).toBeLessThan(60_000);
  });
});
