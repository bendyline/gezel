/**
 * `list_tasks` with no `project` asks for the install-wide listing, which the
 * daemon gives only to a coordinator. A worker's child must fall back to its
 * own project — the listing it may read — instead of returning the 403.
 */
import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { status?: number; body: unknown };
type Handler = (url: URL, method: string) => Reply;

let handler: Handler;
let client: Client;
let httpServer: HttpServer;
let calls: string[];

function task(projectId: string, num: number) {
  return {
    projectId,
    num,
    ref: `${projectId}/${num}`,
    title: `Task ${num}`,
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'dato' },
    craftbook: { steps: [] },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
}

const REFUSED: Reply = {
  status: 403,
  body: { error: 'forbidden', hint: 'global task listing requires a coordinator' },
};

describe('list_tasks without a project', () => {
  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      let reply: Reply;
      try {
        reply = handler(url, req.method ?? 'GET');
      } catch (err) {
        reply = { status: 418, body: { error: String(err) } };
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    vi.stubEnv('GEZEL_MCP_NO_MAIN', '1');
    vi.stubEnv('GEZEL_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GEZEL_TOKEN', 'test-token');
    vi.stubEnv('GEZEL_AGENT_ID', 'dato');
    vi.stubEnv('GEZEL_PROJECT_ID', 'supplier-intake');
    vi.stubEnv('GEZEL_SESSION_ID', 'session-dato');
    vi.stubEnv('GEZEL_HOME', '/tmp/gezel-list-tasks-scope');
    vi.stubEnv('GEZEL_MCP_SCHEMA_LINT', '1');
    const { server } = await import('./server.js');
    client = new Client({ name: 'list-tasks-scope-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    calls = [];
  });

  // Order matters: the child remembers a refusal for the rest of its life,
  // so the coordinator case has to run first.
  it('a coordinator still gets the install-wide listing', async () => {
    handler = (url, method) => {
      if (method === 'GET' && url.pathname === '/api/tasks') {
        return { body: { tasks: [task('supplier-intake', 1), task('marketing', 4)] } };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('marketing/4');
    expect(calls).toEqual(['GET /api/tasks']);
  });

  it('a worker refused the install-wide listing gets its own project instead', async () => {
    handler = (url, method) => {
      if (method === 'GET' && url.pathname === '/api/tasks') return REFUSED;
      if (method === 'GET' && url.pathname === '/api/projects/supplier-intake/tasks') {
        return { body: { tasks: [task('supplier-intake', 1)] } };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
    const result = await client.callTool({
      name: 'list_tasks',
      arguments: { status: 'active' },
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('supplier-intake/1');
    expect(text(result)).toMatch(/this project/i);
    expect(calls).toEqual([
      'GET /api/tasks?status=active',
      'GET /api/projects/supplier-intake/tasks?status=active',
    ]);

    // The token's scope is fixed for the child's life: no second refusal.
    calls = [];
    await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(calls).toEqual(['GET /api/projects/supplier-intake/tasks']);
  });

  it('any other failure is reported, not papered over', async () => {
    handler = (url, method) => {
      if (method === 'GET' && url.pathname === '/api/projects/supplier-intake/tasks') {
        return { status: 500, body: { error: 'disk on fire' } };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('disk on fire');
    expect(calls).toEqual(['GET /api/projects/supplier-intake/tasks']);
  });
});
