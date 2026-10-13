import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveVendoredMxc: vi.fn(),
  resolveWindowsMxcState: vi.fn(),
}));

vi.mock('@bendyline/gezel-inference/internal/engines/resolver', () => ({
  resolveVendoredMxc: mocks.resolveVendoredMxc,
}));

vi.mock('./windows-mxc.js', () => ({
  resolveMxcExecutor: () => null,
  resolveWindowsMxcState: mocks.resolveWindowsMxcState,
  setWindowsMxcEnabled: () => {},
  setWindowsMxcHome: () => {},
  windowsMxcState: () => ({ state: 'unavailable' }),
}));

import { startWindowsScriptSandbox } from './windows-mxc-boot.js';

describe('startWindowsScriptSandbox', () => {
  it('aborts the launcher download on stop and does nothing after it', async () => {
    mocks.resolveWindowsMxcState.mockResolvedValue({ state: 'unavailable' });
    let signal: AbortSignal | undefined;
    mocks.resolveVendoredMxc.mockImplementation(
      (_home: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = opts.signal;
          // A launcher that lands as the stop arrives must not be probed.
          opts.signal.addEventListener('abort', () => resolve('C:/home/wxc-exec.exe'));
        }),
    );
    const store = { readConfig: async () => ({}) } as never;
    const stop = await startWindowsScriptSandbox(store, 'C:/home');
    await vi.waitFor(() => expect(mocks.resolveVendoredMxc).toHaveBeenCalledOnce());

    await stop();

    expect(signal?.aborted).toBe(true);
    expect(mocks.resolveWindowsMxcState).toHaveBeenCalledOnce();
  });
});
