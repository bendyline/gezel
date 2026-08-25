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

describe('well-known docblocks tool schemas', () => {
  it('advertises convert_document arguments and rejects an empty call', async () => {
    // Wild-caught on the 2026-08-22 scorecard sweep (powerpoint-deck 0/33
    // across 11 models): with no inputSchema the models called
    // convert_document with no arguments at all, and the schema-less mock
    // answered the canned success template — the trial "converted" nothing
    // while the provenance checks lit up green.
    runtime = await startMockServices([
      {
        kind: 'mcp',
        id: 'docblocks',
        toolsetId: 'docblocks',
        description: 'fake docblocks',
        tools: [
          {
            name: 'convert_document',
            description: 'Convert approved Markdown.',
            resultTemplate: { artifacts: [{ format: 'pptx', uri: 'mock://deck.pptx' }] },
          },
          { name: 'list_roots', description: 'List roots.', resultTemplate: { roots: [] } },
        ],
      },
    ] as never);
    expect(runtime).toBeTruthy();

    const baseUrl = runtime!.services.get('docblocks')!.baseUrl;
    const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const client = new Client({ name: 'probe', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
      const { tools } = await client.listTools();

      const convert = tools.find((t) => t.name === 'convert_document');
      expect(convert?.inputSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['source', 'targets']),
      });

      // An empty call must be a learnable error, not a canned success.
      const empty = await client
        .callTool({ name: 'convert_document', arguments: {} })
        .catch((err: unknown) => ({ isError: true, caught: String(err) }));
      expect(
        (empty as { isError?: boolean }).isError === true ||
          JSON.stringify(empty).toLowerCase().includes('invalid'),
      ).toBe(true);

      // The lenient forms the product accepts must pass: a plain string
      // source path and a bare-string targets.
      const lenient = (await client.callTool({
        name: 'convert_document',
        arguments: { source: 'powerpoint/eval/deck.md', targets: 'pptx' },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      expect(lenient.isError ?? false).toBe(false);
      expect(lenient.content?.[0]?.text).toContain('mock://deck.pptx');

      // The structured form must also pass.
      const structured = (await client.callTool({
        name: 'convert_document',
        arguments: {
          source: { kind: 'file', path: 'powerpoint/eval/deck.md' },
          targets: [{ format: 'pptx' }],
        },
      })) as { isError?: boolean };
      expect(structured.isError ?? false).toBe(false);
      await client.close();
    } finally {
      if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
  });
});
