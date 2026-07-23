/**
 * End-to-end test for `McpBridge`'s http transport branch. Spins up
 * an in-process MCP server bound to a random localhost port, exposes
 * a couple of trivial tools, and drives them through `McpBridge`
 * with a `kind: 'http'` spec — the same path `ChatManager` uses to
 * bring up registry-imported community toolsets.
 *
 * Two checks: tools come back via `listTools()`, and headers from
 * the spec actually land on the wire (i.e. `Authorization` is
 * honored).
 *
 * Each test gets a fresh server because `StreamableHTTPServerTransport`
 * holds onto its initialized session and rejects a second
 * `initialize` request — sharing a transport across tests trips
 * "Server already initialized".
 */
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpBridge } from './mcp-bridge.js';

interface TestServer {
  url: string;
  /** Last `Authorization` header observed on a POST. Reset per test. */
  lastAuthHeader: { value: string | undefined };
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const mcp = new McpServer({ name: 'test-http-mcp', version: '0.0.1' });
  mcp.registerTool(
    'echo',
    {
      description: 'Echo a string back.',
      inputSchema: { msg: z.string() },
    },
    async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] }),
  );
  mcp.registerTool(
    'whoami',
    {
      description: 'Returns "ok" — used purely to assert the call round-trips.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const lastAuthHeader: { value: string | undefined } = { value: undefined };
  let httpServer: Server;
  await new Promise<void>((resolve) => {
    httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        lastAuthHeader.value = req.headers.authorization;
      }
      // Don't read the body ourselves — `handleRequest` consumes the
      // stream via `@hono/node-server`'s adapter. Pre-parsing here
      // would leave nothing for it to read.
      await transport.handleRequest(req, res, undefined);
    });
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = httpServer!.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  return {
    url,
    lastAuthHeader,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

describe('McpBridge — http transport', () => {
  let server: TestServer;
  let bridge: McpBridge;

  beforeEach(async () => {
    server = await startTestServer();
    bridge = new McpBridge();
  });

  afterEach(async () => {
    await bridge.stop();
    await server.close();
  });

  it('connects, lists tools, and round-trips a tool call', async () => {
    await bridge.start({
      kind: 'http',
      transport: 'streamable-http',
      url: server.url,
      headers: {},
    });
    const names = bridge.getOpenAITools().map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('whoami');

    const result = await bridge.callTool('echo', { msg: 'hello' });
    expect(result).toBe('echo:hello');
  });

  it('passes spec.headers through on every request', async () => {
    await bridge.start({
      kind: 'http',
      transport: 'streamable-http',
      url: server.url,
      headers: { Authorization: 'Bearer test-token-xyz' },
    });
    // The header has to arrive on the connect request itself —
    // listTools() is part of the initialize round-trip.
    expect(server.lastAuthHeader.value).toBe('Bearer test-token-xyz');
    // And on subsequent tool calls.
    server.lastAuthHeader.value = undefined;
    await bridge.callTool('whoami', {});
    expect(server.lastAuthHeader.value).toBe('Bearer test-token-xyz');
  });
});
