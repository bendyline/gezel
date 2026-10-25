import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig, HarnessConnectResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InferProjectDeps } from '../projects/infer-project.js';
import { type RunningService, startService } from '../service.js';

const inferenceMachine = vi.hoisted(() => ({ homedir: '' }));

// The real inference rules run; only the machine they look at is a fixture,
// so a developer's own Documents or cloud mounts cannot change the answer.
vi.mock('../projects/infer-project.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projects/infer-project.js')>();
  return {
    ...actual,
    inferProjectForPath: (
      deps: InferProjectDeps,
      request: Parameters<typeof actual.inferProjectForPath>[1],
      options: Parameters<typeof actual.inferProjectForPath>[2],
    ) =>
      actual.inferProjectForPath(
        {
          ...deps,
          homedir: inferenceMachine.homedir,
          env: { GEZEL_MACHINE_SHARED_HOME: process.env.GEZEL_MACHINE_SHARED_HOME },
        },
        request,
        options,
      ),
  };
});

vi.mock('@bendyline/gezel-inference/internal/memory/embeddings', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) vector[i % vector.length]! += text.charCodeAt(i) / 255;
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };
  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }
  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embeddingPipelineStatus: () => 'ready' as const,
    embeddingsHealth: () => ({ status: 'ready' as const }),
    openEmbeddings: () => {},
    shutdownEmbeddings: async () => {},
    warmEmbeddings: async () => true,
    embed: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
});

let svc: RunningService;
let baseUrl: string;
let httpFetch: typeof fetch;
let fixtureRoot: string;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'gezel-harness-')));
  inferenceMachine.homedir = join(fixtureRoot, 'user-home');
  await mkdir(join(inferenceMachine.homedir, 'code', 'repo', 'src'), { recursive: true });
  svc = await startService({ home: join(fixtureRoot, 'gezel-home') });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

afterEach(async () => {
  await svc.context.store.writeConfig({ harnessTools: {}, securityPolicy: undefined });
});

function call(token: string, method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const connect = (body: unknown, token = svc.context.token) =>
  call(token, 'POST', '/v1/apps/harness-connect', body);
const repo = () => join(inferenceMachine.homedir, 'code', 'repo');

describe('POST /v1/apps/harness-connect', () => {
  it('binds the folder to a new read-only project with no lead gezel', async () => {
    const res = await connect({ client: 'claude-code', folder: repo() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HarnessConnectResponse;
    expect(body.appId).toBe(`harness:claude-code:${body.project?.id}`);
    expect(body.project).toMatchObject({ name: 'repo', readOnly: true, created: true });
    expect(body.memory).toBe('save');
    expect(body.images).toBe('local');
    expect(body.libraryDir).toBeTruthy();
    // The DocBlocks the document tools start: the one this daemon ships.
    expect(body.documents?.entry).toMatch(/docblocks-cli[\\/]dist[\\/]bin\.js$/);

    const project = await svc.context.store.getProject(body.project!.id);
    expect(project?.voormanGezelId).toBeUndefined();
    expect(project?.gezelIds ?? []).toEqual([]);

    // The same app in the same folder shares the token; a subfolder reuses the project.
    const again = (await (
      await connect({ client: 'claude-code', folder: repo() })
    ).json()) as HarnessConnectResponse;
    expect(again.token).toBe(body.token);
    expect(again.project?.created).toBe(false);
    const sub = (await (
      await connect({ client: 'codex', folder: join(repo(), 'src') })
    ).json()) as HarnessConnectResponse;
    expect(sub.project?.id).toBe(body.project?.id);
  });

  it('confines the harness token to its project and the harness routes', async () => {
    const { token, project } = (await (
      await connect({ client: 'claude-code', folder: repo() })
    ).json()) as HarnessConnectResponse;
    const id = project!.id;
    expect(
      (
        await call(token, 'POST', `/api/projects/${id}/tools/search`, {
          query: 'x',
          sources: ['workspace'],
        })
      ).status,
    ).toBe(200);
    expect((await call(token, 'GET', `/api/projects/${id}/index/status`)).status).toBe(200);
    expect((await call(token, 'GET', '/api/documents')).status).toBe(200);

    expect((await call(token, 'PUT', '/api/config', {})).status).toBe(403);
    expect((await call(token, 'GET', '/api/projects')).status).toBe(403);
    expect((await call(token, 'GET', '/api/projects/default')).status).toBe(403);
    expect((await call(token, 'GET', '/events/chat')).status).toBe(403);
    expect(
      (await call(token, 'POST', '/v1/apps/harness-connect', { client: 'codex', folder: repo() }))
        .status,
    ).toBe(403);
  });

  it('stamps a saved memory with the app that saved it', async () => {
    const { token, project } = (await (
      await connect({ client: 'claude-code', folder: repo() })
    ).json()) as HarnessConnectResponse;
    const res = await call(token, 'POST', '/api/memory/save', {
      scope: 'project',
      id: project!.id,
      text: 'The release branch is named trunk.',
      source: { gezel: 'forged' },
    });
    expect(res.status).toBe(200);
    const dailyDir = join(svc.context.home, 'projects', project!.id, 'memories', 'daily');
    const [day] = await readdir(dailyDir);
    const text = await readFile(join(dailyDir, day!), 'utf8');
    expect(text).toContain('{app:claude-code}');
    expect(text).not.toContain('forged');
  });

  it('binds no project for a folder Gezel never owns, or for no folder at all', async () => {
    const home = (await (
      await connect({ client: 'claude-code', folder: inferenceMachine.homedir })
    ).json()) as HarnessConnectResponse;
    expect(home.project).toBeNull();
    expect(home.unboundReason).toBe('forbidden-root');

    const desktop = (await (
      await connect({ client: 'claude-desktop' })
    ).json()) as HarnessConnectResponse;
    expect(desktop.project).toBeNull();
    expect(desktop.unboundReason).toBe('no-folder');
    expect((await call(desktop.token, 'GET', '/api/documents')).status).toBe(200);
  });

  it('adds no project when the person keeps new folders out', async () => {
    await svc.context.store.writeConfig({ harnessTools: { newFolders: 'existing' } });
    const fresh = join(inferenceMachine.homedir, 'code', 'fresh');
    await mkdir(fresh, { recursive: true });
    const body = (await (
      await connect({ client: 'cursor', folder: fresh })
    ).json()) as HarnessConnectResponse;
    expect(body.project).toBeNull();
    expect(body.unboundReason).toBe('not-in-gezel');
  });

  it('refuses when the tools are off, the pair is stopped, or the machine is locked down', async () => {
    const first = (await (
      await connect({ client: 'claude-code', folder: repo() })
    ).json()) as HarnessConnectResponse;

    await svc.context.store.writeConfig({
      harnessTools: { blocked: [{ client: 'claude-code', projectId: first.project!.id }] },
    });
    const stopped = await connect({ client: 'claude-code', folder: repo() });
    expect(stopped.status).toBe(403);
    expect(((await stopped.json()) as { error: string }).error).toBe('harness_disconnected');
    expect((await call(first.token, 'GET', '/api/documents')).status).toBe(403);
    expect((await connect({ client: 'codex', folder: repo() })).status).toBe(200);

    await svc.context.store.writeConfig({ harnessTools: { enabled: false } });
    expect(
      ((await (await connect({ client: 'codex', folder: repo() })).json()) as { error: string })
        .error,
    ).toBe('harness_tools_off');

    await svc.context.store.writeConfig({
      harnessTools: {},
      securityPolicy: {
        level: 'super-lockdown',
        allowFileEdits: false,
        allowExternalChat: false,
        allowExternalServices: false,
        allowScriptExecution: false,
        allowAppNetwork: false,
      },
    } as Partial<GezelConfig>);
    expect(
      ((await (await connect({ client: 'codex', folder: repo() })).json()) as { error: string })
        .error,
    ).toBe('harness_lockdown');
  });

  it('answers only the owner credential, and rejects a folder that does not exist', async () => {
    expect((await connect({ client: 'codex', folder: repo() }, 'not-a-token')).status).toBe(401);
    const missing = await connect({ client: 'codex', folder: join(repo(), 'nope') });
    expect(missing.status).toBe(400);
    expect((await connect({ client: 'not-a-client', folder: repo() })).status).toBe(400);
  });
});

describe('gezel-mcp --harness against the running service', () => {
  it('binds the folder and answers its tools through a harness token', async () => {
    const entry = createRequire(import.meta.url).resolve('@bendyline/gezel-mcp/dist/harness.js');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === 'string' && !pair[0].startsWith('GEZEL_'),
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--harness', 'claude-code', '--folder', repo()],
      env: { ...env, GEZEL_HOME: svc.context.home },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'harness-e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['search', 'read_doc_as_markdown', 'gezel_status']),
      );
      const status = await client.callTool({ name: 'gezel_status', arguments: {} });
      const statusText = (status.content as Array<{ text?: string }>).map((c) => c.text).join('\n');
      expect(status.isError).toBeFalsy();
      expect(statusText).toContain('Project: repo');
      const search = await client.callTool({
        name: 'search',
        arguments: { query: 'release notes' },
      });
      expect(search.isError).toBeFalsy();
      expect(
        svc.context.tokenStore.list().some((r) => r.appId.startsWith('harness:claude-code:')),
      ).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
