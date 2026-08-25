import { resetSuspendClockForTests, startSuspendMonitor } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { EngineBusyError } from '../providers/native/capacity-broker.js';
import { EnrichTimeoutBreaker, classifyEnrichFailure } from './enrich-breaker.js';

function breaker(overrides: Partial<{ threshold: number; cooldownMs: number }> = {}) {
  let clock = 0;
  const opened: Array<{ streak: number; cooldownMs: number }> = [];
  let closes = 0;
  const b = new EnrichTimeoutBreaker({
    threshold: overrides.threshold ?? 3,
    cooldownMs: overrides.cooldownMs ?? 600_000,
    now: () => clock,
    onOpen: (d) => opened.push(d),
    onClose: () => {
      closes += 1;
    },
  });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { b, opened, advance, closes: () => closes };
}

describe('EnrichTimeoutBreaker', () => {
  it('stays closed below the threshold', () => {
    const { b, opened } = breaker();
    b.observe('timeout');
    b.observe('timeout');
    expect(b.isOpen()).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('opens on a consecutive timeout streak', () => {
    const { b, opened } = breaker();
    b.observe('timeout');
    b.observe('timeout');
    b.observe('timeout');
    expect(b.isOpen()).toBe(true);
    expect(opened).toEqual([{ streak: 3, cooldownMs: 600_000 }]);
  });

  it('treats any completed call as proof the target is answering', () => {
    const { b } = breaker();
    b.observe('timeout');
    b.observe('timeout');
    // A file-specific failure still means the engine replied.
    b.observe('failed');
    b.observe('timeout');
    b.observe('timeout');
    expect(b.isOpen()).toBe(false);
  });

  it('closes once the cooldown elapses, with the streak re-armed', () => {
    const { b, advance, closes } = breaker({ cooldownMs: 600_000 });
    for (let i = 0; i < 3; i++) b.observe('timeout');
    expect(b.isOpen()).toBe(true);
    advance(599_999);
    expect(b.isOpen()).toBe(true);
    advance(2);
    expect(b.isOpen()).toBe(false);
    expect(closes()).toBe(1);
    // One more timeout must not immediately re-trip a breaker that has not had
    // a chance to succeed since reopening.
    b.observe('timeout');
    expect(b.isOpen()).toBe(false);
  });

  it('does not re-open, or re-notify, while already open', () => {
    const { b, opened } = breaker();
    for (let i = 0; i < 10; i++) b.observe('timeout');
    expect(opened).toHaveLength(1);
  });

  it('measures its cooldown on the awake clock by default', () => {
    // Default `now` is the awake clock, so a machine that sleeps through the
    // cooldown comes back still backed off rather than counting a nap as
    // recovery time.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-23T10:00:00Z'));
      startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
      const b = new EnrichTimeoutBreaker({ threshold: 1, cooldownMs: 600_000 });
      b.observe('timeout');
      expect(b.isOpen()).toBe(true);
      vi.setSystemTime(Date.now() + 900_000);
      expect(b.isOpen()).toBe(true);
    } finally {
      resetSuspendClockForTests();
      vi.useRealTimers();
    }
  });
});

describe('classifyEnrichFailure', () => {
  it('recognises the one-shot TimeoutError', () => {
    const err = new Error('one-shot timed out after 439s');
    err.name = 'TimeoutError';
    expect(classifyEnrichFailure(err)).toBe('timeout');
  });

  it('recognises provider-level timeouts by message', () => {
    expect(classifyEnrichFailure(new Error('[llama-cpp] timed out after 439s'))).toBe('timeout');
    expect(classifyEnrichFailure(new Error('[Mac AI] timed out after 180s'))).toBe('timeout');
  });

  it('does not classify ordinary failures as timeouts', () => {
    expect(classifyEnrichFailure(new Error('model returned no content'))).toBe('failed');
    expect(classifyEnrichFailure('some string')).toBe('failed');
  });
});

describe('engine-busy is never charged to the target', () => {
  it('classifies a drain refusal as unavailable, not failed', () => {
    expect(
      classifyEnrichFailure(new EngineBusyError('engine mlx:x:0 is busy serving requests')),
    ).toBe('unavailable');
    // Rewrapped by the one-shot layer — only the message survives.
    expect(
      classifyEnrichFailure(
        new Error('engine mlx:x:0 is busy serving requests and did not drain within 30s'),
      ),
    ).toBe('unavailable');
    // "did not drain within 30s" names a duration; it must not read as a timeout.
    expect(classifyEnrichFailure(new Error('[Mac AI] timed out after 180s'))).toBe('timeout');
  });

  it('leaves a timeout streak untouched instead of resetting it', () => {
    const breaker = new EnrichTimeoutBreaker({ threshold: 3 });
    breaker.observe('timeout');
    breaker.observe('timeout');
    // Contention interleaving with a genuinely wedged target used to clear the
    // streak here, so the breaker could never trip.
    breaker.observe('unavailable');
    breaker.observe('timeout');
    expect(breaker.isOpen()).toBe(true);
  });

  it('still lets a real completion clear the streak', () => {
    const breaker = new EnrichTimeoutBreaker({ threshold: 2 });
    breaker.observe('timeout');
    breaker.observe('failed');
    breaker.observe('timeout');
    expect(breaker.isOpen()).toBe(false);
  });
});
