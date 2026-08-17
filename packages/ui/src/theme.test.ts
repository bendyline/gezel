import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from './test-utils/mockApi.js';

vi.mock('./api.js', () => ({ api: createMockApi() }));

import { api } from './api.js';
import { applyThemePref, syncThemeFromConfig } from './theme.js';

/**
 * The app's own surfaces follow `data-theme`, but a project-type page renders
 * in the null-origin preview iframe where our stylesheet cannot reach. The
 * browser-level preference is the only signal that crosses, so every path
 * that settles the theme has to push it — including the boot path where
 * nothing changed, which is the common case.
 */
const setNativeTheme = vi.fn();

/** Only `themePref` matters here; the rest of the config is irrelevant. */
function configWithTheme(themePref: 'system' | 'light' | 'dark') {
  return { provider: 'mock', themePref } as unknown as Awaited<ReturnType<typeof api.getConfig>>;
}

beforeEach(() => {
  setNativeTheme.mockClear();
  window.__GEZEL__ = { ...window.__GEZEL__, setNativeTheme } as Window['__GEZEL__'];
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('applyThemePref', () => {
  it('stamps the document and tells Chromium for an explicit choice', () => {
    applyThemePref('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(setNativeTheme).toHaveBeenCalledWith('dark');
  });

  it('hands control back to the OS on system', () => {
    applyThemePref('dark');
    setNativeTheme.mockClear();
    applyThemePref('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(setNativeTheme).toHaveBeenCalledWith('system');
  });

  it('is harmless outside the desktop shell', () => {
    window.__GEZEL__ = undefined;
    expect(() => applyThemePref('light')).not.toThrow();
  });
});

describe('syncThemeFromConfig', () => {
  it('pushes the preference on boot even when nothing changed', async () => {
    // The regression: server and localStorage agree, so the DOM needs no
    // work — but the browser preference is per process and must still be set,
    // or the preview iframe silently follows the OS all session.
    localStorage.setItem('gezel:theme', 'dark');
    vi.mocked(api.getConfig).mockResolvedValue(configWithTheme('dark'));

    await syncThemeFromConfig();
    expect(setNativeTheme).toHaveBeenCalledWith('dark');
  });

  it('applies and pushes a server preference that differs from the local one', async () => {
    localStorage.setItem('gezel:theme', 'light');
    vi.mocked(api.getConfig).mockResolvedValue(configWithTheme('dark'));

    await syncThemeFromConfig();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(setNativeTheme).toHaveBeenCalledWith('dark');
  });

  it('still pushes the stored preference when the config read fails', async () => {
    localStorage.setItem('gezel:theme', 'dark');
    vi.mocked(api.getConfig).mockRejectedValue(new Error('offline'));

    await syncThemeFromConfig();
    expect(setNativeTheme).toHaveBeenCalledWith('dark');
  });
});
