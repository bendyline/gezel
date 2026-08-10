import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type MockServicesRuntime, startMockServices } from './mock-server.ts';

let runtime: MockServicesRuntime | null = null;
afterEach(async () => {
  await runtime?.close();
  runtime = null;
});

describe('mock MCP advertises the arguments its fixtures need', () => {
  it('declares the destination path so a model is not guessing blind', async () => {
    // Wild-caught twice on live runs: with no inputSchema the model first
    // guessed a different spelling, then called with no arguments at all.
    // Both times the call logged as made and no file was ever written.
    runtime = await startMockServices(
      [
        {
          kind: 'mcp',
          id: 'docblocks',
          description: 'fake',
          tools: [
            {
              name: 'save_artifact',
              description: 'Save the converted document.',
              resultTemplate: { ok: true },
              writeFixture: {
                surface: 'artifact',
                pathArgument: 'destination.path',
                fixture: 'minimal-docx',
              },
            },
            { name: 'list_roots', description: 'List roots.', resultTemplate: { roots: [] } },
            {
              name: 'browser_navigate',
              description: 'Navigate to a URL.',
              resultTemplate: { loaded: true },
            },
          ],
        },
      ] as never,
      {
        mcpToolArgumentSchemas: {
          docblocks: {
            browser_navigate: {
              url: { description: 'Full URL to navigate to.' },
            },
          },
        },
      },
    );
    expect(runtime).toBeTruthy();

    const baseUrl = runtime!.services.get('docblocks')!.baseUrl;
    const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const client = new Client({ name: 'probe', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
      const { tools } = await client.listTools();

      const save = tools.find((t) => t.name === 'save_artifact');
      expect(save?.inputSchema).toBeDefined();
      expect(JSON.stringify(save?.inputSchema)).toContain('destination');
      expect(JSON.stringify(save?.inputSchema)).toContain('path');

      // Tools with no file effect stay permissive on purpose.
      const roots = tools.find((t) => t.name === 'list_roots');
      const rootProps = (roots?.inputSchema as { properties?: object } | undefined)?.properties;
      expect(rootProps === undefined || Object.keys(rootProps).length === 0).toBe(true);

      const navigate = tools.find((t) => t.name === 'browser_navigate');
      expect(navigate?.inputSchema).toMatchObject({
        type: 'object',
        required: ['url'],
        properties: {
          url: expect.objectContaining({
            type: 'string',
            description: 'Full URL to navigate to.',
          }),
        },
      });
      await client.close();
    } finally {
      if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
  });
});
