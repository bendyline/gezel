import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SIDEBAR_SIDE } from '@bendyline/gezel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from './test-utils/mockApi.js';

vi.mock('./api.js', () => ({ api: createMockApi() }));

const { getSidebarSide, setSidebarSide, syncSidebarSideFromConfig } = await import(
  './sidebar-side.js'
);
const { api } = await import('./api.js');

const KEY = 'gezel:sidebar-side';
const stamped = () => document.documentElement.getAttribute('data-sidebar-side');

/** Run the pre-bundle script the way the page does, against this document. */
function runThemeInit(): void {
  // Vitest runs from the package root.
  const source = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8');
  new Function(source)();
}

describe('the navigation rail side', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-sidebar-side');
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);
  });

  // It was the right until 2026-11-11.
  it('is the left until the person chooses', () => {
    expect(DEFAULT_SIDEBAR_SIDE).toBe('left');
    expect(getSidebarSide()).toBe('left');
    window.localStorage.setItem(KEY, 'nonsense');
    expect(getSidebarSide()).toBe('left');
  });

  it('keeps a chosen side by name, in the cache and in the config', () => {
    setSidebarSide('right');
    expect(getSidebarSide()).toBe('right');
    expect(stamped()).toBe('right');
    expect(api.updateConfig).toHaveBeenLastCalledWith({ sidebarSide: 'right' });

    setSidebarSide('left');
    expect(getSidebarSide()).toBe('left');
    expect(stamped()).toBeNull();
    // The default is an absent key, but the config still names the choice.
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(api.updateConfig).toHaveBeenLastCalledWith({ sidebarSide: 'left' });
  });

  // Someone who picked the right before the default moved has no cache key
  // (the old code stored the default as absent) and `right` in their config.
  it('keeps the right for a person who chose it before the default moved', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ sidebarSide: 'right' } as never);
    await syncSidebarSideFromConfig();
    expect(getSidebarSide()).toBe('right');
    expect(stamped()).toBe('right');
  });

  it('leaves the cache alone when the config holds no choice', async () => {
    window.localStorage.setItem(KEY, 'right');
    vi.mocked(api.getConfig).mockResolvedValue({} as never);
    await syncSidebarSideFromConfig();
    expect(getSidebarSide()).toBe('right');
  });

  // The start screen stamps the root from a saved snapshot. Settings shows
  // `getSidebarSide()`, so a stamp nobody repaints is a rail on one side and
  // a picker on the other.
  it('repaints the resolved side over a stamp something else left', async () => {
    const stale = () => document.documentElement.setAttribute('data-sidebar-side', 'right');

    stale();
    vi.mocked(api.getConfig).mockResolvedValue({} as never);
    await syncSidebarSideFromConfig();
    expect(getSidebarSide()).toBe('left');
    expect(stamped()).toBeNull();

    stale();
    vi.mocked(api.getConfig).mockResolvedValue({ sidebarSide: 'left' } as never);
    await syncSidebarSideFromConfig();
    expect(stamped()).toBeNull();

    document.documentElement.removeAttribute('data-sidebar-side');
    window.localStorage.setItem(KEY, 'right');
    vi.mocked(api.getConfig).mockResolvedValue({} as never);
    await syncSidebarSideFromConfig();
    expect(stamped()).toBe('right');
  });

  it('announces a change only when the side moved', async () => {
    const heard = vi.fn();
    window.addEventListener('gezel:sidebar-side-change', heard);
    try {
      vi.mocked(api.getConfig).mockResolvedValue({} as never);
      await syncSidebarSideFromConfig();
      expect(heard).not.toHaveBeenCalled();
      vi.mocked(api.getConfig).mockResolvedValue({ sidebarSide: 'right' } as never);
      await syncSidebarSideFromConfig();
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('gezel:sidebar-side-change', heard);
    }
  });

  // theme-init.js runs before any bundle, so it repeats the default.
  it('paints the same side before the bundle loads', () => {
    runThemeInit();
    expect(stamped()).toBeNull();
    window.localStorage.setItem(KEY, 'right');
    runThemeInit();
    expect(stamped()).toBe('right');
    document.documentElement.removeAttribute('data-sidebar-side');
    window.localStorage.setItem(KEY, 'left');
    runThemeInit();
    expect(stamped()).toBeNull();
  });
});
