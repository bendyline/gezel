import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockProvider } from './mock.js';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const mcp = new McpServer({ name: 'mock-provider-extra-mcp', version: '0.0.1' });
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
      description: 'Returns "ok".',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  let httpServer: Server | undefined;
  await new Promise<void>((resolve, reject) => {
    httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      await transport.handleRequest(req, res, undefined);
    });
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer!.off('error', onError);
      resolve();
    });
  });

  const addr = httpServer!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('MockProvider MCP bridge parity', () => {
  let server: TestServer | undefined;
  let mock: MockProvider | undefined;

  beforeEach(async () => {
    server = await startTestServer();
    mock = new MockProvider({ name: 'openai' });
  });

  afterEach(async () => {
    await mock?.shutdown();
    await server?.close();
  });

  it('uses McpBridgePool so scripted tool calls can reach extra MCP servers', async () => {
    const session = await mock!.createSession({
      systemMessage: 'initial system prompt',
      extraMcpServers: [
        {
          id: 'extra-test',
          kind: 'http',
          transport: 'streamable-http',
          url: server!.url,
          headers: {},
        },
      ],
    });

    expect(session.getRegisteredToolNames?.().sort()).toEqual(['echo', 'whoami']);

    session.setSystemMessage?.('refreshed system prompt');
    mock!.scriptToolCalls([{ name: 'echo', arguments: { msg: 'hello' } }]);
    mock!.script('done');

    await expect(session.sendAndWait('run the extra tool')).resolves.toBe('done');
    expect(mock!.toolCallOutputs).toEqual([{ name: 'echo', output: 'echo:hello' }]);
  });

  it('threads known secrets through the same bridge-pool path', async () => {
    const session = await mock!.createSession({
      systemMessage: 'initial system prompt',
      knownSecretValues: new Set(['secret-token']),
      extraMcpServers: [
        {
          id: 'extra-test',
          kind: 'http',
          transport: 'streamable-http',
          url: server!.url,
          headers: {},
        },
      ],
    });

    mock!.scriptToolCalls([{ name: 'echo', arguments: { msg: 'secret-token' } }]);
    mock!.script('done');

    await session.sendAndWait('run the extra tool');
    expect(mock!.toolCallOutputs).toEqual([{ name: 'echo', output: 'echo:[REDACTED]' }]);
  });
});
