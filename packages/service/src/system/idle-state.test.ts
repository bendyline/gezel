import { describe, expect, it } from 'vitest';
import { SystemIdleState } from './idle-state.js';

describe('SystemIdleState', () => {
  it('returns null until a report arrives', () => {
    expect(new SystemIdleState().osIdleSeconds()).toBeNull();
  });

  it('returns the latest reported value', () => {
    const s = new SystemIdleState();
    s.report(42);
    expect(s.osIdleSeconds()).toBe(42);
    s.report(-5); // clamped to 0
    expect(s.osIdleSeconds()).toBe(0);
  });

  it('treats stale readings as unknown', () => {
    let now = 1_000_000;
    const s = new SystemIdleState(() => now);
    s.report(120);
    expect(s.osIdleSeconds()).toBe(120);
    now += 120_000; // > STALE_MS (90s)
    expect(s.osIdleSeconds()).toBeNull();
  });
});
