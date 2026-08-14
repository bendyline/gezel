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

interface HttpFixtureResponse {
  __status: number;
  body: unknown;
}

function isHttpFixtureResponse(value: unknown): value is HttpFixtureResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { __status?: unknown }).__status === 'number' &&
      'body' in value,
  );
}

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
        res.writeHead(isHttpFixtureResponse(result) ? result.__status : 200, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify(isHttpFixtureResponse(result) ? result.body : result));
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
    vi.stubEnv('GEZEL_MAIL_ENABLED', '1');
    vi.stubEnv('GEZEL_SOCIAL_ENABLED', '1');
    vi.stubEnv('GEZEL_CONNECTORS_ENABLED', '1');

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

  it('advertises compact handoff hints instead of the internal completion-gate union', async () => {
    const { tools } = await client.listTools();
    for (const name of [
      'message_gezel',
      'delegate_developer',
      'delegate_designer',
      'delegate_reviewer',
      'delegate_planner',
      'delegate_researcher',
      'delegate_builder',
      'delegate_writer',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const schema = tool?.inputSchema as {
        properties?: Record<string, { properties?: Record<string, unknown> }>;
      };
      const handoff = schema.properties?.expectedDeliverable;
      expect(handoff, name).toBeDefined();
      expect(Object.keys(handoff?.properties ?? {}).sort(), name).toEqual(['filePath', 'kind']);
      expect(JSON.stringify(handoff), name).not.toContain('checks');
      expect(JSON.stringify(handoff), name).not.toContain('scripts');
      expect(JSON.stringify(handoff).length, name).toBeLessThan(1_000);
    }
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  });

  it('marks non-2xx memory responses as errors instead of empty/saved successes', async () => {
    handler = (url) => {
      if (url.pathname === '/api/memory/save') {
        return { __status: 500, body: { error: 'memory store offline' } };
      }
      if (url.pathname === '/api/memory/search') {
        return { __status: 403, body: { error: 'memory scope denied' } };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const save = await client.callTool({
      name: 'save_memory',
      arguments: { text: 'Remember this', scope: 'project' },
    });
    expect(save.isError).toBe(true);
    expect(JSON.stringify(save.content)).toContain('memory store offline');

    const search = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'remember' },
    });
    expect(search.isError).toBe(true);
    expect(JSON.stringify(search.content)).toContain('memory scope denied');
  });

  it('reports lexical memory fallback as a successful degraded search', async () => {
    handler = (url) => {
      expect(url.pathname).toBe('/api/memory/search');
      return {
        results: [
          {
            text: 'The launch checklist requires a rollback plan.',
            score: 1,
            day: '2026-08-14',
            scope: 'project',
          },
        ],
        mode: 'lexical',
        degraded: {
          code: 'semantic_search_unavailable',
          message:
            'Semantic memory search is temporarily unavailable; searched saved memory text directly instead.',
        },
      };
    };

    const result = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'rollback plan' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      count: 1,
      mode: 'lexical-fallback',
      engine: 'markdown',
    });
    expect(JSON.stringify(result.content)).toContain('temporarily unavailable');
    expect(JSON.stringify(result.content)).toContain('rollback plan');
  });

  it('preserves an opaque server error request id for support correlation', async () => {
    handler = (url) => {
      expect(url.pathname).toBe('/api/memory/search');
      return {
        __status: 500,
        body: { error: 'internal_error', requestId: 'req-memory-123' },
      };
    };

    const result = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'anything' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('internal_error');
    expect(JSON.stringify(result.content)).toContain('req-memory-123');
  });

  it('keeps duplicate memory saves as a structured successful outcome', async () => {
    handler = (url) => {
      expect(url.pathname).toBe('/api/memory/save');
      return { ok: true, status: 'duplicate' };
    };

    const result = await client.callTool({
      name: 'save_memory',
      arguments: { text: 'Remember this', scope: 'project' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      summary: 'Memory already existed (project); no duplicate was added.',
      status: 'duplicate',
      scope: 'project',
    });
  });

  it('reports a durable save as successful when semantic indexing is deferred', async () => {
    handler = (url) => {
      expect(url.pathname).toBe('/api/memory/save');
      return {
        ok: true,
        status: 'saved',
        indexed: false,
        degraded: {
          code: 'semantic_index_unavailable',
          message: 'Memory was saved, but semantic indexing is temporarily unavailable.',
        },
      };
    };

    const result = await client.callTool({
      name: 'save_memory',
      arguments: { text: 'Remember this', scope: 'project' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'saved',
      scope: 'project',
      indexed: false,
    });
    expect(JSON.stringify(result.content)).toContain(
      'semantic indexing is temporarily unavailable',
    );
  });

  it('marks mail and connector draft rejections as MCP execution errors', async () => {
    handler = (url, method) => {
      if (url.pathname === '/api/projects/project-a/connectors' && method === 'GET') {
        return { bindings: [{ id: 'mail-main', type: 'mail-imap' }] };
      }
      if (
        url.pathname === '/api/projects/project-a/connectors/mail-main/actions' &&
        method === 'POST'
      ) {
        return { __status: 422, body: { error: 'recipient is not allowlisted' } };
      }
      if (
        url.pathname === '/api/projects/project-a/connectors/issues/actions' &&
        method === 'POST'
      ) {
        return { __status: 400, body: { error: 'action is not supported' } };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const mail = await client.callTool({
      name: 'draft_email',
      arguments: { to: ['person@example.com'], subject: 'Hello', body: 'Body' },
    });
    expect(mail.isError).toBe(true);
    expect(JSON.stringify(mail.content)).toContain('recipient is not allowlisted');

    const connector = await client.callTool({
      name: 'draft_connector_action',
      arguments: { bindingId: 'issues', action: 'close', input: { issue: 1 } },
    });
    expect(connector.isError).toBe(true);
    expect(JSON.stringify(connector.content)).toContain('action is not supported');
  });

  it('routes draft_post to the first social binding and keeps night-shift publish deferral structured', async () => {
    handler = (url, method, body) => {
      if (url.pathname === '/api/projects/project-a/connectors' && method === 'GET') {
        return {
          bindings: [
            { id: 'mail-main', type: 'mail-imap' },
            { id: 'bsky-main', type: 'bluesky-posts' },
          ],
        };
      }
      if (
        url.pathname === '/api/projects/project-a/connectors/bsky-main/actions' &&
        method === 'POST'
      ) {
        // Images flow through into the drafted action input untouched; the
        // daemon resolves the paths (artifacts first, then workspace).
        expect(body).toEqual({
          action: 'publish',
          input: {
            text: 'Hello from gezel',
            images: [{ path: 'shots/launch.png', alt: 'Launch-day chart' }],
          },
        });
        return { draftId: 'post-1', relPath: 'data/bsky/_actions/_drafts/post-1.md' };
      }
      if (
        url.pathname === '/api/projects/project-a/connectors/actions/post-1/commit' &&
        method === 'POST'
      ) {
        return { status: 'queued-night-shift', relPath: 'data/bsky/_actions/_outbox/post-1.md' };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const draft = await client.callTool({
      name: 'draft_post',
      arguments: {
        text: 'Hello from gezel',
        images: [{ path: 'shots/launch.png', alt: 'Launch-day chart' }],
      },
    });
    expect(draft.isError).not.toBe(true);
    expect(draft.structuredContent).toMatchObject({
      status: 'drafted',
      draftId: 'post-1',
      relPath: 'data/bsky/_actions/_drafts/post-1.md',
    });

    const publish = await client.callTool({
      name: 'publish_post',
      arguments: { draftId: 'post-1' },
    });
    expect(publish.isError).not.toBe(true);
    expect(publish.structuredContent).toMatchObject({
      status: 'queued-night-shift',
      draftId: 'post-1',
      relPath: 'data/bsky/_actions/_outbox/post-1.md',
    });
  });

  it('keeps night-shift email deferral as a structured successful safety outcome', async () => {
    handler = (url, method) => {
      expect(url.pathname).toBe('/api/projects/project-a/connectors/actions/draft-1/commit');
      expect(method).toBe('POST');
      return { status: 'queued-night-shift', relPath: 'mail/outbox/draft-1.json' };
    };

    const result = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft-1' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'queued-night-shift',
      draftId: 'draft-1',
      relPath: 'mail/outbox/draft-1.json',
    });
  });

  it('reads one inclusive line range with original gutters and continuation metadata', async () => {
    let requestBody: Record<string, unknown> | undefined;
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/read-files');
      expect(method).toBe('POST');
      requestBody = body;
      return {
        results: [
          {
            status: 'ok',
            path: 'src/app.ts',
            content: 'const a = 1;\nconst b = 2;',
            startLine: 10,
            endLine: 11,
            linesReturned: 2,
            bytesReturned: 25,
            scannedBytes: 200,
            totalBytes: 900,
            eof: false,
            completeFile: false,
            hasMore: true,
            nextStartLine: 12,
            truncated: false,
          },
        ],
        truncated: false,
        totalBytesReturned: 25,
        totalScannedBytes: 200,
      };
    };

    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: 'src/app.ts', startLine: 10, endLine: 11 },
    });
    expect(requestBody).toEqual({
      files: [{ path: 'src/app.ts', startLine: 10, endLine: 11 }],
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/^\[read_file path="src\/app\.ts" lines=10-11 totalLines=\?\]/);
    expect(text).toContain('10→const a = 1;');
    expect(text).toContain('11→const b = 2;');
    expect(text).toContain('"startLine":12');
  });

  it('redirects an exact artifact collision after read_file misses without opening it', async () => {
    handler = (url, method) => {
      if (url.pathname === '/api/projects/project-a/workspace/read') {
        expect(method).toBe('GET');
        return { __status: 404, body: { error: 'file not found' } };
      }
      if (url.pathname === '/api/projects/project-a/artifacts/slice') {
        expect(method).toBe('GET');
        expect(url.searchParams.get('path')).toBe('security/review-scope.md');
        expect(url.searchParams.get('head')).toBe('0');
        return {
          kind: 'found',
          content: 'THIS CONTENT MUST NOT LEAK THROUGH read_file',
          path: 'security/review-scope.md',
          fuzzy: false,
          linesReturned: 0,
          totalLines: 42,
          bytesReturned: 0,
          totalBytes: 1024,
          hasMore: true,
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: 'security/review-scope.md' },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toContain('A project artifact exists at "security/review-scope.md"');
    expect(text).toContain(
      'call read_artifact({ path: "security/review-scope.md" }) instead of read_file',
    );
    expect(text).toContain('The artifact was not opened automatically.');
    expect(text).not.toContain('THIS CONTENT MUST NOT LEAK');
  });

  it('reads common paths batches, keeps an all-path status index first, and exposes metadata', async () => {
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/read-files');
      expect(method).toBe('POST');
      expect(body).toEqual({ files: [{ path: 'a.ts' }, { path: 'missing.ts' }] });
      return {
        results: [
          {
            status: 'ok',
            path: 'a.ts',
            content: 'export const a = 1;\n',
            startLine: 1,
            endLine: 1,
            linesReturned: 1,
            bytesReturned: 20,
            scannedBytes: 20,
            totalLines: 1,
            totalBytes: 20,
            eof: true,
            completeFile: true,
            hasMore: false,
            truncated: false,
          },
          {
            status: 'error',
            path: 'missing.ts',
            code: 'path-not-found',
            error: 'file not found',
          },
        ],
        truncated: true,
        totalBytesReturned: 20,
        totalScannedBytes: 20,
      };
    };

    const result = await client.callTool({
      name: 'read_files',
      arguments: { paths: ['a.ts', 'missing.ts'] },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/^\[read_files requested=2 ok=1 errors=1\]/);
    expect(text.indexOf('1 OK a.ts')).toBeLessThan(text.indexOf('--- a.ts'));
    expect(text).toContain('2 ERROR missing.ts [path-not-found]');
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      results: [
        { path: 'a.ts', status: 'ok', startLine: 1, endLine: 1, completeFile: true },
        { path: 'missing.ts', status: 'error', code: 'path-not-found' },
      ],
    });
  });

  it('rejects reversed/oversized ranges and raw ranged reads before transport', async () => {
    const call = (arguments_: Record<string, unknown>) =>
      client.callTool({ name: 'read_file', arguments: arguments_ });
    const reversed = await call({ path: 'a.ts', startLine: 20, endLine: 10 });
    expect(reversed.isError).toBe(true);
    expect(JSON.stringify(reversed.content)).toContain('must be greater than or equal');

    const oversized = await call({ path: 'a.ts', startLine: 1, endLine: 401 });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized.content)).toContain('at most 400 lines');

    const rawRange = await call({ path: 'a.ts', startLine: 1, endLine: 2, raw: true });
    expect(rawRange.isError).toBe(true);
    expect(JSON.stringify(rawRange.content)).toContain('cannot be combined');
  });

  it('calls grep_files with the hardened search contract and renders grep-style context', async () => {
    let requestBody: Record<string, unknown> | undefined;
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/search-files');
      expect(method).toBe('POST');
      requestBody = body;
      return {
        mode: 'matches',
        matches: [
          {
            path: 'src/app.ts',
            line: 12,
            text: 'const needle = true;',
            before: [{ line: 11, text: '// before' }],
            after: [{ line: 13, text: '// after' }],
          },
        ],
        files: [],
        count: 1,
        truncated: true,
        truncationReason: 'limit',
        nextCursor: 1,
        engine: 'ripgrep',
      };
    };

    const result = await client.callTool({
      name: 'grep_files',
      arguments: {
        pattern: 'needle',
        literal: true,
        includeGlobs: ['**/*.ts'],
        contextLines: 1,
        maxResults: 1,
      },
    });
    expect(requestBody).toMatchObject({
      pattern: 'needle',
      literal: true,
      includeGlobs: ['**/*.ts'],
      contextLines: 1,
      maxResults: 1,
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? '')
      .join('\n');
    expect(text).toContain('src/app.ts-11-// before');
    expect(text).toContain('src/app.ts:12:const needle = true;');
    expect(text).toContain('src/app.ts-13-// after');
    expect(text).toContain('Continue with cursor=1');
    expect(result.structuredContent).toEqual({
      summary: '1 match (engine=ripgrep).',
      query: 'needle',
      matches: [
        {
          path: 'src/app.ts',
          line: 12,
          text: 'const needle = true;',
          before: [{ line: 11, text: '// before' }],
          after: [{ line: 13, text: '// after' }],
        },
      ],
      count: 1,
      truncated: true,
      engine: 'ripgrep',
      mode: 'matches',
      nextCursor: 1,
      truncationReason: 'limit',
    });
  });

  it('marks anticipated Playwright process failures as MCP execution errors', async () => {
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/run-playwright');
      expect(method).toBe('POST');
      expect(body).toEqual({ path: 'tests/failing.spec.ts' });
      return { ok: false, log: '1 test failed', error: 'exit 1' };
    };

    const result = await client.callTool({
      name: 'run_playwright_script',
      arguments: { path: 'tests/failing.spec.ts' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('1 test failed');
  });

  it('marks an entirely declined npm install batch as an execution error', async () => {
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/npm-install');
      expect(method).toBe('POST');
      expect(body).toMatchObject({ packages: [{ package: 'left-pad' }] });
      return {
        results: [
          {
            kind: 'declined',
            package: 'left-pad',
            version: 'latest',
            reason: 'User declined this dependency.',
          },
        ],
      };
    };

    const result = await client.callTool({
      name: 'npm_install',
      arguments: { packages: [{ package: 'left-pad' }] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('User declined this dependency.');
  });

  it('returns validated structured task data for reads and mutations', async () => {
    handler = (url, method, body) => {
      if (url.pathname === '/api/projects/project-a/tasks/7' && method === 'GET') {
        return {
          ref: 'project-a/7',
          title: 'Ship it',
          status: 'active',
          craftbook: { steps: [] },
        };
      }
      if (url.pathname === '/api/projects/project-a/tasks/7/status' && method === 'POST') {
        expect(body).toEqual({ status: 'paused' });
        return {
          ref: 'project-a/7',
          title: 'Ship it',
          status: 'paused',
          craftbook: { steps: [] },
        };
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };

    const read = await client.callTool({
      name: 'get_task',
      arguments: { ref: 'project-a/7' },
    });
    expect(read.structuredContent).toMatchObject({
      summary: 'Loaded task project-a/7.',
      operation: 'get',
      ref: 'project-a/7',
      status: 'active',
    });

    const update = await client.callTool({
      name: 'set_task_status',
      arguments: { ref: 'project-a/7', status: 'paused' },
    });
    expect(update.isError).not.toBe(true);
    expect(update.structuredContent).toMatchObject({
      summary: 'project-a/7 → paused',
      operation: 'set_status',
      ref: 'project-a/7',
      status: 'paused',
    });
  });

  it('returns validated structured Git execution data', async () => {
    handler = (url, method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/git');
      expect(method).toBe('POST');
      expect(body).toEqual({ subcommand: 'status', args: ['--short'] });
      return {
        code: 0,
        stdout: ' M src/app.ts\n',
        stderr: '',
        stdoutTruncated: false,
        timedOut: false,
      };
    };

    const result = await client.callTool({
      name: 'run_git',
      arguments: { subcommand: 'status', args: ['--short'] },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      summary: 'git status completed (exit 0).',
      state: 'completed',
      ok: true,
      command: 'git',
      args: ['status', '--short'],
      code: 0,
      stdout: ' M src/app.ts\n',
      stderr: '',
      stdoutTruncated: false,
      timedOut: false,
    });
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
