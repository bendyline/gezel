import { afterEach, expect, it, vi } from 'vitest';
import { setVisibleInterval } from './visible-interval.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('pauses hidden polling, reconciles on return, and removes its timer and listener', () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const read = vi.fn();
  const stop = setVisibleInterval(read, 1_000);
  vi.advanceTimersByTime(1_000);
  expect(read).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(10_000);
  expect(read).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(10_000);
  expect(read).toHaveBeenCalledTimes(2);
});
