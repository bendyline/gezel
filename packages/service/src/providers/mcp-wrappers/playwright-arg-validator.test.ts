import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TOOLSETS } from '../../system-toolsets/manifest.js';
import { installDirName } from '../../system-toolsets/resolve.js';
import { selectWrappersFor } from './index.js';
import {
  LOCAL_PREVIEW_BROWSER_TOOLS,
  PlaywrightArgValidator,
  hasLocalPreviewBrowserNetworkOverride,
  localPreviewBrowserLaunchArgs,
  workspaceFileNavigation,
} from './playwright-arg-validator.js';
import type { McpToolWrapperContext } from './types.js';

function ctx(extra: Partial<McpToolWrapperContext> = {}): McpToolWrapperContext {
  return {
    spec: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    cwd: '/tmp',
    modelTier: 'large',
    isMeester: false,
    hasTool: () => true,
    callTool: vi.fn(async () => ({ text: '', images: [] })),
    ...extra,
  };
}

describe('PlaywrightArgValidator', () => {
  const localPreview = {
    root: resolve('workspace'),
    projectId: 'p',
    origin: 'http://127.0.0.1:41234',
    localOnly: true,
    createUrl: vi.fn(async () => null),
  };

  it('matches @playwright/mcp servers', () => {
    expect(
      PlaywrightArgValidator.matches({
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: {},
      }),
    ).toBe(true);
  });

  // Derived from the real install layout on purpose: `installDirName`
  // slugifies `@playwright/mcp` into `@playwright__mcp@<version>`, so the
  // package name is absent from the spawn command for the copy Gezel
  // manages. Selecting wrappers by sniffing that command line left all four
  // browser wrappers inert against exactly that copy — `browser_navigate`
  // handed Chromium the raw `file:` URL the prompt teaches, and
  // playwright-core rejects it outright. Build the spec the way ChatManager
  // does so a future slug change fails here instead of in the field.
  it('selects every browser wrapper for the managed system-toolset spawn spec', () => {
    const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === '@playwright/mcp');
    if (!entry?.entry) throw new Error('@playwright/mcp is no longer a pinned system toolset');
    const installRoot = join(
      systemToolsetsInstallDir(resolve('home')),
      installDirName(entry),
      'package',
    );
    expect(installRoot).not.toContain('@playwright/mcp');

    const selected = selectWrappersFor({
      toolsetId: entry.toolsetId,
      kind: 'stdio',
      command: 'node',
      args: [join(installRoot, entry.entry), '--headless'],
      env: {},
    }).map((w) => w.id);

    expect(selected).toEqual(
      expect.arrayContaining([
        'playwright-arg-validator',
        'playwright-tool-descriptions',
        'playwright-snapshot-inliner',
        'playwright-auto-screenshot',
      ]),
    );
  });

  it('allows browser_navigate with a real https URL', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'https://news.ycombinator.com' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('allows http URLs (localhost, intranet)', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'http://localhost:3000/page' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('prunes the local-only surface before schemas reach the model', () => {
    const tools = [
      {
        type: 'function' as const,
        name: 'browser_snapshot',
        description: 'snapshot',
        parameters: {
          type: 'object',
          properties: { filename: { type: 'string' }, verbose: { type: 'boolean' } },
          required: ['filename'],
        },
      },
      {
        type: 'function' as const,
        name: 'browser_evaluate',
        description: 'evaluate arbitrary JavaScript',
        parameters: { type: 'object' },
      },
      {
        type: 'function' as const,
        name: 'browser_navigate',
        description: 'navigate',
        parameters: { type: 'object' },
      },
    ];
    const decorated = PlaywrightArgValidator.decorateTools!(
      tools,
      ctx({ workspacePreview: localPreview }),
    );
    expect(decorated.map((tool) => tool.name)).toEqual(['browser_snapshot', 'browser_navigate']);
    expect(decorated[0]?.parameters.properties).toEqual({ verbose: { type: 'boolean' } });
    expect(decorated[0]?.parameters.required).toEqual([]);
    expect(LOCAL_PREVIEW_BROWSER_TOOLS.has('browser_evaluate')).toBe(false);
  });

  it('rejects unsafe tools and strips MCP file-output arguments in local-only mode', async () => {
    const unsafe = await PlaywrightArgValidator.preProcess!(
      'browser_run_code_unsafe',
      { code: 'fetch("https://example.com")' },
      ctx({ workspacePreview: localPreview }),
    );
    expect(unsafe.kind).toBe('reject');
    if (unsafe.kind === 'reject') expect(unsafe.error).toContain('local-preview-only');

    const snapshot = await PlaywrightArgValidator.preProcess!(
      'browser_snapshot',
      { filename: '../../outside.txt', verbose: true },
      ctx({ workspacePreview: localPreview }),
    );
    expect(snapshot).toEqual({ kind: 'allow', args: { verbose: true } });
  });

  it('allows only this project capability URL or about:blank in local-only mode', async () => {
    const capability = 'A'.repeat(43);
    const allowed = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: `http://127.0.0.1:41234/preview/${capability}/workspace/p/index.html` },
      ctx({ workspacePreview: localPreview }),
    );
    expect(allowed.kind).toBe('allow');

    for (const url of [
      'https://example.com',
      'http://127.0.0.1:3000/index.html',
      `http://127.0.0.1:41234/preview/${capability}/workspace/other/index.html`,
      'javascript:alert(1)',
    ]) {
      const verdict = await PlaywrightArgValidator.preProcess!(
        'browser_navigate',
        { url },
        ctx({ workspacePreview: localPreview }),
      );
      expect(verdict.kind, url).toBe('reject');
    }

    expect(
      (
        await PlaywrightArgValidator.preProcess!(
          'browser_navigate',
          { url: 'about:blank' },
          ctx({ workspacePreview: localPreview }),
        )
      ).kind,
    ).toBe('allow');
  });

  it('forces every browser request through the preview-only listener', () => {
    expect(localPreviewBrowserLaunchArgs(localPreview.origin, [])).toEqual([
      '--proxy-server',
      localPreview.origin,
      '--proxy-bypass',
      '<-loopback>',
      '--allowed-origins',
      localPreview.origin,
      '--block-service-workers',
    ]);
    expect(
      localPreviewBrowserLaunchArgs(localPreview.origin, [
        `--proxy-server=${localPreview.origin}`,
        '--proxy-bypass',
        '<-loopback>',
        '--allowed-origins',
        localPreview.origin,
        '--block-service-workers',
      ]),
    ).toEqual([]);
    expect(hasLocalPreviewBrowserNetworkOverride(['--proxy-server=http://example.com'])).toBe(true);
    expect(hasLocalPreviewBrowserNetworkOverride(['--headless', '--isolated'])).toBe(false);
  });

  it('allows about:blank and similar URI schemes', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'about:blank' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('rewrites the portable workspace alias to a scoped preview URL', async () => {
    const createUrl = vi.fn(async (path: string) =>
      path === 'site/index.html'
        ? 'http://127.0.0.1:41234/preview/token/workspace/p/site/index.html'
        : null,
    );
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'file:///workspace/site/index.html?turn=2#map', timeout: 5_000 },
      ctx({ workspacePreview: { root: resolve('workspace'), projectId: 'p', createUrl } }),
    );
    expect(createUrl).toHaveBeenCalledWith('site/index.html');
    expect(v).toEqual({
      kind: 'allow',
      args: {
        url: 'http://127.0.0.1:41234/preview/token/workspace/p/site/index.html?turn=2#map',
        timeout: 5_000,
      },
    });
  });

  it('maps a real platform file URL when it is inside the workspace', () => {
    const root = resolve('tmp', 'active-workspace');
    const fileUrl = pathToFileURL(join(root, 'game', 'index.html')).toString();
    expect(workspaceFileNavigation(fileUrl, { root, projectId: 'empire-wargame' })).toEqual({
      relativePath: 'game/index.html',
      search: '',
      hash: '',
    });
  });

  it('maps a foreign-OS project-shaped file URL to the active workspace', () => {
    expect(
      workspaceFileNavigation('file:///home/user/projects/empire-wargame/index.html', {
        root: resolve('tmp', 'active-workspace'),
        projectId: 'empire-wargame',
      }),
    ).toEqual({ relativePath: 'index.html', search: '', hash: '' });
  });

  it('rejects file URLs outside the workspace with no safe alias', async () => {
    const createUrl = vi.fn(async () => 'http://127.0.0.1/preview/never');
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'file:///home/user/secrets/index.html' },
      ctx({
        workspacePreview: {
          root: resolve('tmp', 'active-workspace'),
          projectId: 'empire-wargame',
          createUrl,
        },
      }),
    );
    expect(createUrl).not.toHaveBeenCalled();
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.error).toContain('outside the workspace');
  });

  it('rejects aliases for files that do not exist in the active workspace', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'file:///workspace/missing.html' },
      ctx({
        workspacePreview: {
          root: resolve('tmp', 'active-workspace'),
          projectId: 'empire-wargame',
          createUrl: vi.fn(async () => null),
        },
      }),
    );
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') {
      expect(v.error).toContain('workspace file "missing.html" was not found');
      expect(v.error).toContain('validate({ path: "index.html" })');
      expect(v.error).toContain('do NOT install `serve`');
    }
  });

  it('rejects file URLs when no project preview context is available', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'file:///workspace/index.html' },
      ctx(),
    );
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.error).toContain('preview hosting unavailable');
  });

  it('rejects a search-query-shaped URL with a teaching error', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'world news' },
      ctx(),
    );
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') {
      expect(v.error).toContain("'world news'");
      expect(v.error).toContain('https://');
      expect(v.error).toContain('not a URL');
    }
  });

  it('rejects a domain-without-scheme', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'nytimes.com' },
      ctx(),
    );
    expect(v.kind).toBe('reject');
  });

  it('rejects an empty url', async () => {
    const v = await PlaywrightArgValidator.preProcess!('browser_navigate', { url: '' }, ctx());
    expect(v.kind).toBe('reject');
  });

  it('passes through tools other than browser_navigate', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_click',
      { ref: 'e10', element: 'Search button' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('passes through when url is missing or non-string', async () => {
    const a = await PlaywrightArgValidator.preProcess!('browser_navigate', {}, ctx());
    const b = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 42 as unknown as string },
      ctx(),
    );
    expect(a.kind).toBe('allow');
    expect(b.kind).toBe('allow');
  });
});
