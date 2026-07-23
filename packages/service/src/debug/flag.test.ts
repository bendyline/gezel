import { describe, expect, it } from 'vitest';
import { DebugFlag } from './flag.js';

describe('DebugFlag', () => {
  it('defaults to off', () => {
    expect(new DebugFlag().isEnabled()).toBe(false);
  });

  it('seeds from the constructor argument', () => {
    expect(new DebugFlag(true).isEnabled()).toBe(true);
    expect(new DebugFlag(false).isEnabled()).toBe(false);
  });

  it('flips in place via set()', () => {
    const flag = new DebugFlag();
    flag.set(true);
    expect(flag.isEnabled()).toBe(true);
    flag.set(false);
    expect(flag.isEnabled()).toBe(false);
  });

  it('coerces truthy/falsy non-booleans defensively', () => {
    const flag = new DebugFlag();
    // HTTP route passes `body.debugMode === true` but be defensive in case
    // a caller hands us something looser.
    flag.set(1 as unknown as boolean);
    expect(flag.isEnabled()).toBe(false);
    flag.set(true);
    expect(flag.isEnabled()).toBe(true);
    flag.set(null as unknown as boolean);
    expect(flag.isEnabled()).toBe(false);
  });
});
