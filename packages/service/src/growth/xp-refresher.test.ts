import { afterEach, describe, expect, it, vi } from 'vitest';
import { createXpRefresher } from './xp-refresher.js';

afterEach(() => {
  vi.useRealTimers();
});

// XP was recomputed only on the daily sweep, so a gezel who had just finished
// a step still showed 0 XP.
describe('createXpRefresher', () => {
  it('refreshes the credited gezel once per burst and reports the new XP', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (gezelId: string) => ({ xp: gezelId === 'ada' ? 20 : 10 }));
    const onRefreshed = vi.fn();
    const refresher = createXpRefresher({ refresh, onRefreshed, delayMs: 1000 });

    refresher.note('ada');
    refresher.note('ada');
    refresher.note(undefined);
    refresher.note('bo');
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(['ada', 'bo']);
    expect(onRefreshed).toHaveBeenCalledWith('ada', 20);
    expect(onRefreshed).toHaveBeenCalledWith('bo', 10);
  });

  it('drops pending refreshes on dispose and survives a failed one', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {
      throw new Error('store closed');
    });
    const onRefreshed = vi.fn();
    const refresher = createXpRefresher({ refresh, onRefreshed, delayMs: 10 });

    refresher.note('ada');
    await vi.advanceTimersByTimeAsync(10);
    expect(onRefreshed).not.toHaveBeenCalled();

    refresher.note('bo');
    refresher.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it('serializes slow refreshes across gezels and coalesces work arriving in flight', async () => {
  vi.useFakeTimers();
  const releases: Array<() => void> = [];
  let active = 0,
    maximum = 0;
  const refresh = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return { xp: 20 };
  });
  const refresher = createXpRefresher({ refresh, onRefreshed: vi.fn(), delayMs: 10 });
  refresher.note('ada');
  await vi.advanceTimersByTimeAsync(10);
  refresher.note('bo');
  for (let i = 0; i < 20; i++) {
    refresher.note('ada');
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(refresh).toHaveBeenCalledTimes(1);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(2);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(3);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(maximum).toBe(1);
  refresher.dispose();
});

it('disposal during a refresh discards its notification and queued follow-ups', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<{ xp: number }>((resolve) => {
        release = () => resolve({ xp: 10 });
      }),
  );
  const onRefreshed = vi.fn();
  const refresher = createXpRefresher({ refresh, onRefreshed, delayMs: 10 });
  refresher.note('ada');
  await vi.advanceTimersByTimeAsync(10);
  refresher.note('bo');
  await vi.advanceTimersByTimeAsync(10);
  refresher.dispose();
  refresher.note('cy');
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onRefreshed).not.toHaveBeenCalled();
});
