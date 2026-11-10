import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderQueue } from './provider-queue.js';
import {
  ProviderRateLimitError,
  RateLimitGovernor,
  type RateLimitGovernorState,
  isProviderRateLimitError,
} from './provider-rate-limit.js';

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ProviderQueue — throttle', () => {
  it('admits no more than the limit, and lifting it drains the waiters', async () => {
    const q = new ProviderQueue({ concurrency: 4 });
    q.throttle({ limit: 2 });
    const r1 = await q.acquire({ lane: 'background' });
    const r2 = await q.acquire({ lane: 'background' });
    const p3 = q.acquire({ lane: 'background' });
    await flush();
    expect(q.snapshot()).toMatchObject({ running: 2, queuedBackground: 1 });
    expect(q.hasCapacity('background')).toBe(false);
    expect(q.describe().throttle).toEqual({ limit: 2 });

    q.clearThrottle();
    const r3 = await p3;
    expect(q.snapshot().running).toBe(3);
    expect(q.hasCapacity('background')).toBe(true);
    expect(q.describe().throttle).toBeUndefined();
    for (const release of [r1, r2, r3]) release();
  });

  it('holds new dispatch until the hold ends, then wakes on its own', async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 4, now: clock.now });
    q.throttle({ holdUntil: clock.now() + 30_000, reason: '429' });
    const pending = q.acquire({ lane: 'background' });
    await flush();
    expect(q.snapshot()).toMatchObject({ running: 0, queuedBackground: 1 });
    expect(q.hasCapacity('background')).toBe(false);
    expect(q.describe().throttle).toMatchObject({ limit: 4, reason: '429' });

    clock.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const release = await pending;
    expect(q.snapshot().running).toBe(1);
    release();
  });

  it('never moves a hold earlier', () => {
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 2, now: clock.now });
    q.throttle({ holdUntil: clock.now() + 60_000 });
    q.throttle({ holdUntil: clock.now() + 10_000 });
    clock.advance(20_000);
    expect(q.hasCapacity('background')).toBe(false);
    q.clearThrottle();
  });
});

describe('RateLimitGovernor', () => {
  function setup(concurrency = 40) {
    const clock = fakeClock();
    const queue = new ProviderQueue({ concurrency, now: clock.now });
    const changes: RateLimitGovernorState[] = [];
    const governor = new RateLimitGovernor(queue, { onChange: (s) => changes.push(s) });
    return { clock, queue, governor, changes };
  }

  async function occupy(queue: ProviderQueue, n: number): Promise<Array<() => void>> {
    const releases: Array<() => void> = [];
    for (let i = 0; i < n; i++) releases.push(await queue.acquire({ lane: 'background' }));
    return releases;
  }

  it('halves what is in flight, and counts one burst of refusals once', async () => {
    const { queue, governor, clock } = setup();
    const releases = await occupy(queue, 40);
    for (let i = 0; i < 40; i++) governor.rateLimited();
    expect(governor.limit).toBe(20);
    expect(queue.admissionConcurrency).toBe(20);

    clock.advance(30_000);
    governor.rateLimited();
    expect(governor.limit).toBe(10);
    for (const release of releases) release();
    clock.advance(1_000_000);
    queue.clearThrottle();
  });

  it('halves a small burst from its own size, not the configured width', async () => {
    const { queue, governor } = setup();
    const releases = await occupy(queue, 3);
    governor.rateLimited();
    expect(governor.limit).toBe(1);
    for (const release of releases) release();
    queue.clearThrottle();
  });

  it('holds dispatch for the retry-after, bounded', async () => {
    const { queue, governor, clock } = setup();
    governor.rateLimited({ retryAfterMs: 10 * 60_000 });
    clock.advance(119_000);
    expect(queue.hasCapacity('background')).toBe(false);
    clock.advance(2_000);
    expect(queue.hasCapacity('background')).toBe(true);
    queue.clearThrottle();
  });

  it('widens one slot at a time once refusals stop, then lifts the throttle', async () => {
    const { queue, governor, clock, changes } = setup(4);
    const releases = await occupy(queue, 4);
    governor.rateLimited();
    expect(governor.limit).toBe(2);

    clock.advance(30_000);
    governor.succeeded();
    expect(governor.limit).toBe(2); // still inside the recovery delay

    clock.advance(30_000);
    governor.succeeded();
    expect(governor.limit).toBe(3);
    governor.succeeded();
    expect(governor.limit).toBe(3); // one step per spacing

    clock.advance(10_000);
    governor.succeeded();
    expect(governor.limit).toBeUndefined();
    expect(queue.isThrottled).toBe(false);
    expect(changes.map((c) => c.change)).toEqual(['narrowed', 'widened', 'lifted']);
    for (const release of releases) release();
  });

  it('a fresh refusal while widening narrows again from the current limit', async () => {
    const { queue, governor, clock } = setup(40);
    const releases = await occupy(queue, 8);
    governor.rateLimited(); // 8 → 4
    clock.advance(60_000);
    governor.succeeded(); // 5
    governor.rateLimited(); // 5 → 2
    expect(governor.limit).toBe(2);
    for (const release of releases) release();
    queue.clearThrottle();
  });
});

describe('ProviderRateLimitError', () => {
  it('is recognized by class and by name', () => {
    expect(isProviderRateLimitError(new ProviderRateLimitError('429'))).toBe(true);
    const copy = Object.assign(new Error('429'), { name: 'ProviderRateLimitError' });
    expect(isProviderRateLimitError(copy)).toBe(true);
    expect(isProviderRateLimitError(new Error('turn timed out'))).toBe(false);
  });
});
