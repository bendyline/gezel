import { describe, expect, it, vi } from 'vitest';
import { guardDebugSignal } from './debug-signal-guard.js';

function fakeProcess(over: Partial<Parameters<typeof guardDebugSignal>[0]> = {}) {
  const on = vi.fn();
  return { proc: { platform: 'linux' as const, execArgv: [], env: {}, on, ...over }, on };
}

// A sandboxed script can send SIGUSR1 (or call _debugProcess on Windows) to
// the daemon and run code in it through the inspector that opens.
describe('guardDebugSignal', () => {
  it('trusts the flag, whether on the command line or in NODE_OPTIONS', () => {
    expect(guardDebugSignal(fakeProcess({ execArgv: ['--disable-sigusr1'] }).proc)).toBe('flag');
    const { proc, on } = fakeProcess({
      platform: 'win32',
      env: { NODE_OPTIONS: '--max-old-space-size=4096 --disable-sigusr1' },
    });
    expect(guardDebugSignal(proc)).toBe('flag');
    expect(on).not.toHaveBeenCalled();
  });

  it('takes SIGUSR1 from the inspector on POSIX when the flag is missing', () => {
    const { proc, on } = fakeProcess({ platform: 'darwin' });
    expect(guardDebugSignal(proc)).toBe('listener');
    expect(on).toHaveBeenCalledWith('SIGUSR1', expect.any(Function));
  });

  it('leaves a daemon started under an inspector alone', () => {
    const { proc, on } = fakeProcess({ execArgv: ['--inspect=9230'] });
    expect(guardDebugSignal(proc)).toBe('inspector');
    expect(on).not.toHaveBeenCalled();
  });

  it('names an unguarded Windows daemon, which no listener can protect', () => {
    expect(guardDebugSignal(fakeProcess({ platform: 'win32' }).proc)).toBe('unguarded');
    expect(guardDebugSignal(fakeProcess({ platform: 'win32', type: 'utility' }).proc)).toBe(
      'electron',
    );
  });
});
