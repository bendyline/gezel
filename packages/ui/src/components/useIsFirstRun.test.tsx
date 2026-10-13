import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { useIsFirstRun } from './useIsFirstRun.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { api } = await import('../api.js');

async function reportProviderReady(ready: boolean) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('gezel:first-run', { detail: { firstRun: !ready } }));
  });
}

describe('first-run versus provider health', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'openai' } as never);
    vi.mocked(api.getSystemHomeInfo).mockResolvedValue({ usage: { everUsed: false } } as never);
  });

  it('offers setup in an unused home with no working provider', async () => {
    const { result } = renderHook(() => useIsFirstRun());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('keeps an established workshop out of onboarding after failed probes and config changes', async () => {
    vi.mocked(api.getSystemHomeInfo).mockResolvedValue({ usage: { everUsed: true } } as never);
    const { result } = renderHook(() => useIsFirstRun());
    await reportProviderReady(false);
    expect(result.current).toBe(false);
    await act(async () => window.dispatchEvent(new Event('gezel:config-updated')));
    expect(result.current).toBe(false);
    expect(api.getSystemHomeInfo).toHaveBeenCalledTimes(1);
  });

  it('does not reopen onboarding after the first successful provider probe', async () => {
    const { result } = renderHook(() => useIsFirstRun());
    await waitFor(() => expect(result.current).toBe(true));
    await reportProviderReady(true);
    expect(result.current).toBe(false);
    await reportProviderReady(false);
    await act(async () => window.dispatchEvent(new Event('gezel:config-updated')));
    expect(result.current).toBe(false);
  });

  it('waits for usage evidence before accepting a failed Home probe', async () => {
    let resolveUsage!: (value: never) => void;
    vi.mocked(api.getSystemHomeInfo).mockReturnValue(
      new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    );
    const { result } = renderHook(() => useIsFirstRun());
    await reportProviderReady(false);
    expect(result.current).toBe(false);
    await act(async () => resolveUsage({ usage: { everUsed: true } } as never));
    expect(result.current).toBe(false);
  });
});
