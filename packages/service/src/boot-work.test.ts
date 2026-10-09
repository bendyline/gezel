import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferBootWork } from './boot-work.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('deferred boot work', () => {
  it('runs once after the delay while the service is up', () => {
    const work = vi.fn();
    deferBootWork(20_000, work, () => false);
    vi.advanceTimersByTime(19_999);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledOnce();
  });

  it('never runs once stop() cancels it', () => {
    const work = vi.fn();
    const cancel = deferBootWork(20_000, work, () => false);
    cancel();
    vi.advanceTimersByTime(20_000);
    expect(work).not.toHaveBeenCalled();
  });

  it('skips work that comes due after shutdown has begun', () => {
    // A timer already queued when stop() starts must not load a model worker
    // that process.exit would tear down mid-load.
    let stopping = false;
    const work = vi.fn();
    deferBootWork(20_000, work, () => stopping);
    stopping = true;
    vi.advanceTimersByTime(20_000);
    expect(work).not.toHaveBeenCalled();
  });
});
