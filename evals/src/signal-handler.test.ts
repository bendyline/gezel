import { describe, expect, it, vi } from 'vitest';
import { createTwoStageSignalHandler } from './signal-handler.ts';

describe('createTwoStageSignalHandler', () => {
  it('collapses an immediate duplicate into one graceful abort', () => {
    let now = 1_000;
    const abort = vi.fn();
    const forceExit = vi.fn();
    const log = vi.fn();
    const handler = createTwoStageSignalHandler({ abort, forceExit, log, now: () => now });

    handler('SIGINT');
    now += 200;
    handler('SIGINT');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('duplicate SIGINT');
  });

  it('force-exits on a deliberately later second signal', () => {
    let now = 1_000;
    const abort = vi.fn();
    const forceExit = vi.fn();
    const handler = createTwoStageSignalHandler({
      abort,
      forceExit,
      log: vi.fn(),
      now: () => now,
    });

    handler('SIGTERM');
    now += 1_000;
    handler('SIGINT');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(130);
  });
});
