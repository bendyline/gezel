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

import { awaitWindowsScriptSandboxBoot, startWindowsScriptSandbox } from './windows-mxc-boot.js';

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

describe('awaitWindowsScriptSandboxBoot', () => {
  it('holds a session build until the launcher lands and the probe settles', async () => {
    mocks.resolveWindowsMxcState.mockReset();
    mocks.resolveWindowsMxcState.mockResolvedValue({ state: 'unavailable' });
    let land: (path: string) => void = () => {};
    mocks.resolveVendoredMxc.mockReset();
    mocks.resolveVendoredMxc.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          land = resolve;
        }),
    );
    const store = { readConfig: async () => ({}) } as never;
    const stop = await startWindowsScriptSandbox(store, 'C:/home');
    await vi.waitFor(() => expect(mocks.resolveVendoredMxc).toHaveBeenCalledOnce());

    let built = false;
    const waiting = awaitWindowsScriptSandboxBoot().then(() => {
      built = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(built).toBe(false);

    land('C:/home/wxc-exec.exe');
    await waiting;
    expect(mocks.resolveWindowsMxcState).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('gives up after its bound when the launcher never lands', async () => {
    mocks.resolveWindowsMxcState.mockReset();
    mocks.resolveWindowsMxcState.mockResolvedValue({ state: 'unavailable' });
    mocks.resolveVendoredMxc.mockReset();
    mocks.resolveVendoredMxc.mockImplementation(
      (_home: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(null))),
    );
    const store = { readConfig: async () => ({}) } as never;
    const stop = await startWindowsScriptSandbox(store, 'C:/home');

    await expect(awaitWindowsScriptSandboxBoot(10)).resolves.toBeUndefined();
    await stop();
  });
});
