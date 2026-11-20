import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('./daemon-host.js', () => ({ daemonHost: () => calls.push('daemonHost') }));
vi.mock('./debug-signal-guard.js', () => ({
  guardDebugSignalOnce: () => {
    calls.push('guardDebugSignal');
    return 'unguarded';
  },
}));
vi.mock('./log-routing.js', () => ({
  routeServiceLogs: (output: string) => {
    calls.push(`routeServiceLogs:${output}`);
    return async () => {
      calls.push('restoreLogs');
    };
  },
}));
vi.mock('./runtime-discovery.js', () => ({
  resolveEffectiveServiceRole: async () => {
    calls.push('resolveRole');
    throw new Error('stop before booting a real service');
  },
}));

const { startService } = await import('./service.js');

describe('startService', () => {
  // The Windows debug-signal warning printed above `gezel run`'s setup
  // guidance because the guard ran before the CLI's 'file' routing existed
  // (2026-11-20 npm rehearsal). Its record must go where the caller routed logs.
  it('routes logs before the debug-signal guard can write a record', async () => {
    calls.length = 0;
    await expect(startService({ home: 'unused', logOutput: 'file' })).rejects.toThrow(
      'stop before booting',
    );
    expect(calls).toEqual([
      'daemonHost',
      'routeServiceLogs:file',
      'guardDebugSignal',
      'resolveRole',
      'restoreLogs',
    ]);
  });
});
