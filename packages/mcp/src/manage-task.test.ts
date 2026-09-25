/**
 * `manage_task` is the Meester's lifecycle control over the craftbook runs it
 * launches in Default, which has no voorman. The service decides whether a
 * restart is allowed (only inside a turn the user started); these cases pin
 * what the tool sends and how it reads each answer back to the model.
 */
import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { status?: number; body: unknown };
type Handler = (url: URL, method: string, body: Record<string, unknown> | undefined) => Reply;

let handler: Handler;
let client: Client;
let httpServer: HttpServer;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;

function task(status: string) {
  return {
    projectId: 'default',
    num: 11,
    ref: 'default/11',
    title: 'PowerPoint from Content',
    status,
    activeStepId: 'research',
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
}

describe('manage_task', () => {
  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      calls.push({ method: req.method ?? 'GET', path: url.pathname, ...(body ? { body } : {}) });
      const reply = handler(url, req.method ?? 'GET', body);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    vi.stubEnv('GEZEL_MCP_NO_MAIN', '1');
    vi.stubEnv('GEZEL_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GEZEL_TOKEN', 'test-token');
    vi.stubEnv('GEZEL_AGENT_ID', 'meester');
    vi.stubEnv('GEZEL_PROJECT_ID', 'default');
    vi.stubEnv('GEZEL_SESSION_ID', 'session-meester');
    vi.stubEnv('GEZEL_HOME', '/tmp/gezel-manage-task');
    vi.stubEnv('GEZEL_MCP_SCHEMA_LINT', '1');

    const { server } = await import('./server.js');
    client = new Client({ name: 'manage-task-test', version: '1.0.0' }, { capabilities: {} });
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
    handler = (url, method) => {
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
  });

  it('resumes a paused task through retry, resolving a bare number in its own project', async () => {
    handler = (url, method) => {
      if (method === 'GET' && url.pathname === '/api/projects/default/tasks/11') {
        return { body: task('paused') };
      }
      if (method === 'POST' && url.pathname === '/api/projects/default/tasks/11/retry') {
        return {
          body: {
            task: task('active'),
            dispatched: true,
            gezelId: 'agathe',
            assigneeName: 'Agathe',
          },
        };
      }
      if (method === 'POST' && url.pathname === '/api/projects/default/tasks/11/notes') {
        return { body: { note: { id: 'n1', at: '2026-09-23T17:00:00Z', text: 'x' } } };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };

    const result = await client.callTool({
      name: 'manage_task',
      arguments: { ref: '11', action: 'retry', reason: 'The user asked to try again.' },
    });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Restarted default/11');
    expect(text(result)).toContain('Agathe');
    // Retry, not a bare status flip: only retry resets the spent budgets.
    expect(calls.some((c) => c.path.endsWith('/tasks/11/status'))).toBe(false);
    const note = calls.find((c) => c.path.endsWith('/tasks/11/notes'));
    expect(String(note?.body?.text)).toContain('The user asked to try again.');
  });

  it('tells the model to ask the user when the service refuses an unrequested restart', async () => {
    handler = (url, method) => {
      if (method === 'GET' && url.pathname === '/api/projects/default/tasks/11') {
        return { body: task('paused') };
      }
      if (method === 'POST' && url.pathname === '/api/projects/default/tasks/11/retry') {
        return {
          status: 403,
          body: { error: 'restarting a paused task needs the user to ask for it in this turn' },
        };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };

    const result = await client.callTool({
      name: 'manage_task',
      arguments: { ref: 'default/11', action: 'resume' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Only the user can restart default/11');
    expect(text(result)).toContain('Retryable: false');
  });

  it('pauses and cancels through the status route', async () => {
    let status = 'active';
    handler = (url, method, body) => {
      if (method === 'GET' && url.pathname === '/api/projects/default/tasks/11') {
        return { body: task(status) };
      }
      if (method === 'POST' && url.pathname === '/api/projects/default/tasks/11/status') {
        status = String(body?.status);
        return { body: task(status) };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };

    const paused = await client.callTool({
      name: 'manage_task',
      arguments: { ref: 'default/11', action: 'pause' },
    });
    expect(text(paused)).toContain('Paused default/11');

    const canceled = await client.callTool({
      name: 'manage_task',
      arguments: { ref: 'default/11', action: 'cancel' },
    });
    expect(text(canceled)).toContain('Canceled default/11');
    expect(calls.filter((c) => c.path.endsWith('/status')).map((c) => c.body?.status)).toEqual([
      'paused',
      'canceled',
    ]);
  });

  it('offers no way to mark a task complete', async () => {
    const result = await client.callTool({
      name: 'manage_task',
      arguments: { ref: 'default/11', action: 'complete' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
