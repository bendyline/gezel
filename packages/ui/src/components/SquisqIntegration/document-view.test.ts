import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConfig = vi.fn();
const updateConfig = vi.fn();
vi.mock('../../api.js', () => ({
  api: {
    getConfig: () => getConfig(),
    updateConfig: (body: unknown) => updateConfig(body),
  },
}));

const STORAGE_KEY = 'gezel:document-view:v1';

/** The choice is module-scoped (one for every viewer), so each case loads it fresh. */
async function load() {
  vi.resetModules();
  return import('./document-view.js');
}

beforeEach(() => {
  window.localStorage.clear();
  getConfig.mockReset();
  getConfig.mockResolvedValue({});
  updateConfig.mockReset();
  updateConfig.mockResolvedValue({});
});

describe('useDocumentViewProps', () => {
  it('chooses nothing until the person does, so the outline starts hidden', async () => {
    const { useDocumentViewProps } = await load();
    const { result } = renderHook(() => useDocumentViewProps());

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    expect(result.current.viewPreferences).toEqual({});
    expect(result.current.viewPreferences?.outline).toBeUndefined();
  });

  it('gives a choice made in one viewer to every open viewer and to the config', async () => {
    const { useDocumentViewProps } = await load();
    const artifacts = renderHook(() => useDocumentViewProps());
    const library = renderHook(() => useDocumentViewProps());
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    act(() => {
      artifacts.result.current.onViewPreferencesChange?.({
        outline: true,
        inlinePreview: false,
        showStatusBar: true,
        blockTags: true,
        blockTagVisibility: 'active',
        themeInheritance: 'none',
        layoutMode: 'document',
      });
    });

    const expected = {
      outline: true,
      inlinePreview: false,
      showStatusBar: true,
      blockTagVisibility: 'active',
      themeInheritance: 'none',
      layoutMode: 'document',
    };
    expect(library.result.current.viewPreferences).toEqual(expected);
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ documentView: expected }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(expected);
  });

  it('opens on the choice the config holds, and caches it for the next first paint', async () => {
    getConfig.mockResolvedValue({ documentView: { outline: true } });
    const { useDocumentViewProps } = await load();
    const { result } = renderHook(() => useDocumentViewProps());

    await waitFor(() => expect(result.current.viewPreferences).toEqual({ outline: true }));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      outline: true,
    });
  });

  it('paints the cached choice before the config read lands', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ outline: true }));
    getConfig.mockReturnValue(new Promise(() => {}));
    const { useDocumentViewProps } = await load();
    const { result } = renderHook(() => useDocumentViewProps());

    expect(result.current.viewPreferences).toEqual({ outline: true });
  });

  it('keeps a choice made while the config read was still out', async () => {
    let answer: (config: unknown) => void = () => {};
    getConfig.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { useDocumentViewProps } = await load();
    const { result } = renderHook(() => useDocumentViewProps());
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    act(() => {
      result.current.onViewPreferencesChange?.({ outline: false });
    });
    await act(async () => {
      answer({ documentView: { outline: true } });
    });

    expect(result.current.viewPreferences).toEqual({ outline: false });
  });

  it('keeps its identity until the choice changes, which is what squisq re-applies on', async () => {
    const { useDocumentViewProps } = await load();
    const { result, rerender } = renderHook(() => useDocumentViewProps());
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    const first = result.current;

    rerender();
    expect(result.current).toBe(first);

    act(() => {
      result.current.onViewPreferencesChange?.({ outline: true });
    });
    const chosen = result.current.viewPreferences;
    expect(chosen).not.toBe(first.viewPreferences);

    act(() => {
      result.current.onViewPreferencesChange?.({ outline: true });
    });
    expect(result.current.viewPreferences).toBe(chosen);
  });

  it('drops values this build does not know', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ outline: true, layoutMode: 'gallery', themeInheritance: 3 }),
    );
    const { useDocumentViewProps } = await load();
    const { result } = renderHook(() => useDocumentViewProps());

    expect(result.current.viewPreferences).toEqual({ outline: true });
  });
});
