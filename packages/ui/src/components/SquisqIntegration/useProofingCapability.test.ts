import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROVIDER = { lint: async () => [] };

vi.mock('@bendyline/squisq-editor-react', () => ({
  createHarperProofingProvider: vi.fn(() => PROVIDER),
}));

const getConfig = vi.fn();
vi.mock('../../api.js', () => ({ api: { getConfig: () => getConfig() } }));

/**
 * The preference cache is module-scoped (one fetch for every editor on
 * screen), so each case needs a fresh registry.
 */
async function load() {
  vi.resetModules();
  return import('./useProofingCapability.js');
}

function configUpdated(detail: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail }));
  });
}

beforeEach(async () => {
  getConfig.mockReset();
  getConfig.mockResolvedValue({});
  // The squisq mock outlives `vi.resetModules()`, so its call log carries
  // across cases unless it is cleared here.
  const { createHarperProofingProvider } = await import('@bendyline/squisq-editor-react');
  vi.mocked(createHarperProofingProvider).mockClear();
});

describe('useProofingCapability', () => {
  it('hands the editor the warm engine when either kind of checking is on', async () => {
    const { useProofingCapability } = await load();
    const { result } = renderHook(() => useProofingCapability());

    await waitFor(() => expect(result.current).not.toBeNull());
  });

  it('never loads the engine when both kinds are off', async () => {
    // The WASM is ~15 MB and fetched on the first pass, so "off" has to
    // mean the capability is absent, not that findings are filtered away.
    getConfig.mockResolvedValue({ inlineSpellChecking: false, inlineGrammarChecking: false });
    const { useProofingCapability } = await load();
    const { result } = renderHook(() => useProofingCapability());

    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(result.current).toBeNull();

    const { createHarperProofingProvider } = await import('@bendyline/squisq-editor-react');
    expect(createHarperProofingProvider).not.toHaveBeenCalled();
  });

  it('drops the capability for a tick when the filter changes, so an open editor re-lints', async () => {
    // Squisq keeps its provider once built — the enable flag is what makes
    // it schedule a fresh pass, so a filter change has to ride that flip.
    const { useProofingCapability } = await load();
    const { result } = renderHook(() => useProofingCapability());
    await waitFor(() => expect(result.current).not.toBeNull());

    configUpdated({ inlineSpellChecking: true, inlineGrammarChecking: false });
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).not.toBeNull());
  });

  it('applies a Settings change to the provider filter without a refetch', async () => {
    const { useProofingCapability } = await load();
    const { getProofingPreferences } = await import('./proofing.js');
    renderHook(() => useProofingCapability());
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));

    configUpdated({ inlineSpellChecking: false, inlineGrammarChecking: true });

    expect(getProofingPreferences()).toEqual({ spelling: false, grammar: true });
    expect(getConfig).toHaveBeenCalledTimes(1);
  });
});
