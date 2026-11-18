import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { registerWebTools } from './web-tools.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
type WebApi = Pick<
  GezelClient,
  'listWebPages' | 'getWebPage' | 'requestWebPage' | 'readProjectArtifact'
>;

function setup(api: Partial<Record<keyof WebApi, unknown>>) {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _shape: unknown, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  registerWebTools({
    server: server as unknown as McpServer,
    api: api as unknown as WebApi,
    projectId: 'p1',
    unwrapApiError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return async (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args, {});
}

const text = (r: CallToolResult) => (r.content[0]?.type === 'text' ? r.content[0].text : '');

const SAVED = {
  url: 'https://docs.test/intro',
  title: 'Introduction',
  site: 'docs.test',
  bindingId: 'website:1',
  state: 'saved',
  path: 'data/docs/docs-test/001--intro--abcd1234.md',
  screenshots: [],
  capturedAt: '2026-11-16T09:00:00Z',
  summary: 'How to start.',
};
const FOUND = {
  ...SAVED,
  url: 'https://docs.test/deep',
  title: 'Deep',
  state: 'skipped',
  path: undefined,
  reason: 'Further from the start address than this connection follows.',
};

describe('saved web page tools', () => {
  it('lists saved pages and found links, labeled untrusted', async () => {
    const call = setup({
      listWebPages: async () => ({ bindings: [], pages: [SAVED, FOUND], truncated: false }),
    });
    const r = await call('list_web_pages');
    expect(text(r)).toMatch(/1 saved page\(s\), 1 found but not saved/);
    expect(text(r)).toMatch(/untrusted/);
    expect(r.structuredContent?.items).toHaveLength(2);
  });

  it('reads a saved copy without visiting the page', async () => {
    const readProjectArtifact = vi.fn(async () => ({
      path: SAVED.path,
      content: '# Introduction\n\nHow to start.',
    }));
    const call = setup({ getWebPage: async () => ({ page: SAVED }), readProjectArtifact });
    const r = await call('read_web_page', { url: SAVED.url });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('How to start.');
    expect(readProjectArtifact).toHaveBeenCalledWith('p1', SAVED.path);
  });

  it('turns an address the crawler never found into the person’s decision', async () => {
    const call = setup({
      requestWebPage: async () => ({
        status: 'needs-permission',
        message: 'This address is not a link Gezel has found on a site this project follows.',
      }),
    });
    const r = await call('request_web_page', {
      url: 'https://evil.test/?q=secret',
      reason: 'to check something',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/did not fetch it/);
    expect(text(r)).toMatch(/they can save it themselves/);
  });

  it('returns the saved file for a found link', async () => {
    const call = setup({ requestWebPage: async () => ({ status: 'saved', page: SAVED }) });
    const r = await call('request_web_page', { url: SAVED.url, reason: 'the install steps' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: 'saved', relPath: SAVED.path });
  });
});
