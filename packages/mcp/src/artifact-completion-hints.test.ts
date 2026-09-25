/** Actual MCP artifact replies must respect the active step's completion rule. */
import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('artifact completion guidance', () => {
  let httpServer: HttpServer;
  let client: Client;
  let mode: 'automatic' | 'manual' | 'unavailable' | 'stale' = 'automatic';
  let writes: unknown[] = [];
  let taskReads = 0;

  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let status = 200;
      let result: unknown;
      if (req.method === 'GET' && req.url === '/api/projects/project-a/tasks/42') {
        taskReads++;
        if (mode === 'unavailable') {
          status = 503;
          result = { error: 'Transient task lookup failure' };
        } else {
          result = {
            projectId: 'project-a',
            num: 42,
            ref: 'project-a/42',
            status: 'active',
            assignee: { kind: 'gezel', gezelId: 'writer' },
            activeStepId: mode === 'stale' ? 'next' : 'work',
            craftbook: {
              steps: [
                {
                  id: 'work',
                  terminal: true,
                  ...(mode === 'automatic'
                    ? {
                        advanceWhen: {
                          file: 'tasks/42/report.json',
                          artifact: true,
                          requireChange: true,
                        },
                      }
                    : {}),
                },
              ],
            },
          };
        }
      } else if (req.method === 'PUT' && req.url === '/api/projects/project-a/artifacts/write') {
        writes.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        result = { ok: true, path: 'tasks/42/report.json' };
      } else {
        status = 500;
        result = { error: `Unexpected request ${req.method} ${req.url}` };
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    for (const [key, value] of Object.entries({
      GEZEL_MCP_NO_MAIN: '1',
      GEZEL_BASE_URL: `http://127.0.0.1:${port}`,
      GEZEL_TOKEN: 'test-token',
      GEZEL_AGENT_ID: 'writer',
      GEZEL_PROJECT_ID: 'project-a',
      GEZEL_HOME: join(tmpdir(), `gezel-artifact-hints-${process.pid}`),
      GEZEL_SESSION_ID: 'artifact-hint-test',
      GEZEL_TASK_REF: 'project-a/42',
      GEZEL_STEP_ID: 'work',
      GEZEL_MCP_SCHEMA_LINT: '1',
    }))
      vi.stubEnv(key, value);
    const { server } = await import('./server.js');
    client = new Client({ name: 'artifact-hint-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => {
    mode = 'automatic';
    writes = [];
    taskReads = 0;
  });
  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  async function save(content: Record<string, unknown> = { ready: true }) {
    const result = await client.callTool({
      name: 'write_artifact',
      arguments: { path: 'tasks/42/report.json', jsonContent: content, force: true },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { result, text };
  }

  it('preserves the exact write acknowledgement and gives automatic completion guidance', async () => {
    const { result, text } = await save();
    expect(result.isError).not.toBe(true);
    expect(text.split('\n')[0]).toBe('Wrote tasks/42/report.json');
    expect(text).toContain('automatic completion checks');
    expect(text).toContain('Saving does not approve');
    expect(text).not.toContain('call advance_task_step');
    expect(text).toContain('save the complete deliverable again');
    expect(writes).toHaveLength(1);
    expect(taskReads).toBe(1);
  });

  it('retains explicit submission guidance for a manual step', async () => {
    mode = 'manual';
    const { result, text } = await save();
    expect(result.isError).not.toBe(true);
    expect(text).toContain('call advance_task_step');
    expect(text).not.toContain('automatic completion');
    expect(writes).toHaveLength(1);
  });

  it('refreshes metadata and gives conditional guidance after a transient lookup failure', async () => {
    expect((await save()).text).toContain('automatic completion checks');
    mode = 'unavailable';
    const { result, text } = await save();
    expect(result.isError).not.toBe(true);
    expect(text).toContain('Follow the active craftbook completion rule');
    expect(text).not.toContain('This step uses automatic completion checks');
    expect(writes).toHaveLength(2);
    expect(taskReads).toBe(2);
    mode = 'manual';
    expect((await save()).text).not.toContain('automatic completion');
  });

  it('keeps the stale-step mutation fence and does not acknowledge a refused write', async () => {
    mode = 'stale';
    const { result, text } = await save();
    expect(result.isError).toBe(true);
    expect(text).not.toContain('Wrote tasks/42/report.json');
    expect(writes).toHaveLength(0);
  });

  it('does not claim a malformed artifact was saved or submitted', async () => {
    const result = await client.callTool({
      name: 'write_artifact',
      arguments: { path: 'tasks/42/report.json', content: '{broken', force: true },
    });
    expect(result.isError).toBe(true);
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(result.content)).not.toContain('automatic completion checks');
  });
});
