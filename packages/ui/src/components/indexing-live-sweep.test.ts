import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INDEXING_SWEEP_LINGER_MS,
  IndexingLiveSweeps,
  indexingSweepKey,
} from './indexing-live-sweep.js';

const sweepKey = indexingSweepKey('boekwachter', 'workshop');

describe('indexing live sweeps', () => {
  let retired: string[];
  let sweeps: IndexingLiveSweeps;

  beforeEach(() => {
    vi.useFakeTimers();
    retired = [];
    sweeps = new IndexingLiveSweeps((key) => retired.push(key));
  });

  afterEach(() => {
    sweeps.reset();
    vi.useRealTimers();
  });

  function start(sessionId: string, path: string, projectId = 'workshop'): string {
    return sweeps.liveKey(sessionId, 'boekwachter', projectId, `Indexing ${path}`);
  }

  it('folds every file of a sweep into one live slot', () => {
    expect(start('one-shot:a', 'src/app.ts')).toBe(sweepKey);
    sweeps.finish('one-shot:a');
    vi.advanceTimersByTime(INDEXING_SWEEP_LINGER_MS - 1);
    expect(start('one-shot:b', 'src/lib.ts')).toBe(sweepKey);
    // Later events of a joined session carry no activity and still follow it.
    expect(sweeps.liveKey('one-shot:b', 'boekwachter', 'workshop')).toBe(sweepKey);

    vi.advanceTimersByTime(INDEXING_SWEEP_LINGER_MS * 2);
    expect(retired).toEqual([]);
    expect(sweeps.isSweep(sweepKey)).toBe(true);
  });

  it('retires the slot once no file has been in flight for the linger window', () => {
    start('one-shot:a', 'src/app.ts');
    start('one-shot:b', 'src/lib.ts');
    sweeps.finish('one-shot:a');
    vi.advanceTimersByTime(INDEXING_SWEEP_LINGER_MS * 2);
    expect(retired).toEqual([]);

    sweeps.finish('one-shot:b');
    expect(sweeps.isSweep(sweepKey)).toBe(true);
    vi.advanceTimersByTime(INDEXING_SWEEP_LINGER_MS);
    expect(retired).toEqual([sweepKey]);
    expect(sweeps.isSweep(sweepKey)).toBe(false);
    expect(sweeps.liveKey('one-shot:b', 'boekwachter', 'workshop')).toBe('one-shot:b');
  });

  it('leaves chat turns and other background one-shots on their own sessions', () => {
    expect(sweeps.liveKey('chat-1', 'boekwachter', 'workshop', 'Indexing src/app.ts')).toBe(
      'chat-1',
    );
    expect(sweeps.liveKey('one-shot:c', 'boekwachter', 'workshop', 'Summarizing the thread')).toBe(
      'one-shot:c',
    );
    expect(start('one-shot:d', 'src/app.ts', 'elsewhere')).toBe(
      indexingSweepKey('boekwachter', 'elsewhere'),
    );
  });

  it('forgets a sweep whose slot was retired elsewhere', () => {
    start('one-shot:a', 'src/app.ts');
    sweeps.forget(sweepKey);
    expect(sweeps.isSweep(sweepKey)).toBe(false);
    expect(sweeps.liveKey('one-shot:a', 'boekwachter', 'workshop')).toBe('one-shot:a');
    vi.advanceTimersByTime(INDEXING_SWEEP_LINGER_MS * 2);
    expect(retired).toEqual([]);
  });
});
