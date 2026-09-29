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
