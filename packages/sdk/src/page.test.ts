import { describe, expect, it, vi } from 'vitest';
import {
  GEZEL_PAGE_API_VERSION,
  type GezelPageApi,
  type GezelPageError,
  type GezelPageTheme,
} from './page.js';

describe('Output Pane page API contract', () => {
  it('pins the public API generation to version 1', () => {
    expect(GEZEL_PAGE_API_VERSION).toBe(1);
  });

  it('supports the documented embedded-page facade', async () => {
    const refresh = vi.fn();
    const themeChanged = vi.fn();
    const watchChanged = vi.fn();
    const darkTheme: GezelPageTheme = { mode: 'dark' };

    const pageApi: GezelPageApi = {
      page: {
        api: GEZEL_PAGE_API_VERSION,
        projectId: 'project-1',
        source: 'type',
        entry: 'board/index.html',
        typeName: 'Planning board',
        params: { laneCount: 3 },
        mode: 'embedded',
      },
      tools: {
        list: () => ['create-card'],
        invoke: async (tool, input) => ({
          output: { tool, input },
          runId: 'run-1',
          reaction: { delivered: true, gezelId: 'planner' },
        }),
      },
      data: {
        read: async (path, opts) => ({ path, source: opts?.source ?? 'workspace' }),
        list: async () => [
          { name: 'cards.json', kind: 'file', size: 42, mtime: 1_786_579_200_000 },
        ],
        watch: (path, cb) => {
          cb({ path, etag: 'etag-1' });
          return () => {};
        },
        url: (path) => `/api/page/read/${path}`,
      },
      ui: {
        theme: darkTheme,
        onTheme: (cb) => {
          cb(darkTheme);
          return () => {};
        },
      },
      refresh,
    };

    expect(pageApi.page).toMatchObject({ api: 1, mode: 'embedded', source: 'type' });
    expect(pageApi.tools.list()).toEqual(['create-card']);
    await expect(pageApi.tools.invoke('create-card', { title: 'Ship it' })).resolves.toMatchObject({
      runId: 'run-1',
      reaction: { delivered: true, gezelId: 'planner' },
    });
    await expect(pageApi.data.read('cards.json')).resolves.toEqual({
      path: 'cards.json',
      source: 'workspace',
    });
    await expect(pageApi.data.list('.')).resolves.toEqual([
      { name: 'cards.json', kind: 'file', size: 42, mtime: 1_786_579_200_000 },
    ]);
    pageApi.data.watch('cards.json', watchChanged);
    expect(watchChanged).toHaveBeenCalledWith({ path: 'cards.json', etag: 'etag-1' });
    pageApi.ui.onTheme(themeChanged);
    expect(themeChanged).toHaveBeenCalledWith({ mode: 'dark' });
    expect(pageApi.data.url('cards.json')).toBe('/api/page/read/cards.json');
    pageApi.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps page errors branchable by stable code and optional run id', () => {
    const error = Object.assign(new Error('tool timed out'), {
      code: 'timeout' as const,
      runId: 'run-2',
    }) satisfies GezelPageError;

    expect(error).toMatchObject({ code: 'timeout', runId: 'run-2' });
  });
});
