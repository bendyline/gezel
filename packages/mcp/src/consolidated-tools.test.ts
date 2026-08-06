import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RequestHandler = (
  url: URL,
  method: string,
  body: Record<string, unknown> | undefined,
) => unknown | Promise<unknown>;

let handler: RequestHandler;
let client: Client;
let httpServer: HttpServer;

describe('consolidated MCP tools', () => {
  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        const result = await handler(
          new URL(req.url ?? '/', 'http://127.0.0.1'),
          req.method ?? 'GET',
          body,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    vi.stubEnv('GEZEL_MCP_NO_MAIN', '1');
    vi.stubEnv('GEZEL_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GEZEL_TOKEN', 'test-token');
    vi.stubEnv('GEZEL_AGENT_ID', 'meester');
    vi.stubEnv('GEZEL_PROJECT_ID', 'project-a');
    vi.stubEnv('GEZEL_SESSION_ID', 'session-a');
    vi.stubEnv('GEZEL_HOME', '/tmp/gezel-consolidated-tools');

    const { server } = await import('./server.js');
    client = new Client(
      { name: 'gezel-consolidated-tools-test', version: '1.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => {
    handler = (url) => {
      throw new Error(`Unexpected request: ${url}`);
    };
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  });

  it('creates from an exact gilde template through create_gezel without a redundant role', async () => {
    let installedBody: Record<string, unknown> | undefined;
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/catalog/gezel-template/designer/install');
      expect(method).toBe('POST');
      installedBody = body;
      return {
        id: 'designer-1',
        name: body?.name,
        role: 'Designer',
      };
    };

    const result = await client.callTool({
      name: 'create_gezel',
      arguments: { templateId: 'designer' },
    });

    expect(installedBody).toMatchObject({ gender: expect.any(String), name: expect.any(String) });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('from template "designer"'),
        }),
      ]),
    );
  });

  it('lists shared-roster and workspace-local gezels in one labeled result', async () => {
    handler = (url) => {
      switch (url.pathname) {
        case '/api/projects/project-a/gezels':
          return { projectId: 'project-a', gezelIds: ['shared-1'] };
        case '/api/projects/project-a/local-gezels':
          return {
            gezels: [
              { id: 'proj__project-a__project', name: '@project', role: 'Repository guide' },
            ],
          };
        case '/api/gezels':
          return { gezels: [{ id: 'shared-1', name: 'Maya', role: 'Developer' }] };
        default:
          throw new Error(`Unexpected request: ${url}`);
      }
    };

    const result = await client.callTool({
      name: 'list_project_gezels',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? '')
      .join('\n');

    expect(text).toContain('Shared roster (1):');
    expect(text).toContain('Maya (Developer)');
    expect(text).toContain('Workspace-local (1):');
    expect(text).toContain('@project (Repository guide)');
  });

  it('marks a missing message project as non-retryable without blaming the display name', async () => {
    handler = (url) => {
      if (url.pathname === '/api/projects') {
        return {
          projects: [
            { id: 'default', name: 'Default' },
            { id: 'squisq', name: 'squisq' },
          ],
        };
      }
      if (url.pathname.startsWith('/api/projects/')) {
        throw new Error('project not found');
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await client.callTool({
      name: 'message_gezel',
      arguments: {
        gezel: 'voorman',
        project: 'Battle of Ypres Presentation',
        message: 'Please start the outline.',
      },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? '')
      .join('\n');

    expect(result.isError).toBe(true);
    expect(text).toContain('does not exist');
    expect(text).toContain('[runtime: non-retryable]');
    expect(text).toContain('Project ids and exact display names are both accepted');
    expect(text).toContain('Call `list_projects`');
    expect(text).not.toContain('not the display name');
  });
});
