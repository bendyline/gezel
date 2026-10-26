import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GEZEL_API_GENERATION,
  GEZEL_API_GENERATION_FLOOR,
  HARNESS_DOCUMENT_TOOL_NAMES,
  HARNESS_TOOL_NAMES,
  type HarnessConnectResponse,
} from '@bendyline/gezel';
import {
  DaemonNotRunningError,
  GezelClient,
  type LocalGezel,
  type LocalGezelLaunch,
  type LocalGezelOptions,
  type ManagedFetch,
} from '@bendyline/gezel-client/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarnessServer, parseHarnessArgs } from './index.js';
import { type HarnessOptions, HarnessSession } from './session.js';

type Handler = (body: unknown, url: URL) => unknown;

interface Fake {
  connect: (opts: LocalGezelOptions) => Promise<LocalGezel>;
  exchanges: unknown[];
  requests: Array<{ method: string; path: string; auth: string | null; body: unknown }>;
  routes: Map<string, Handler>;
}

let root: string;
let folder: string;
let library: string;
let artifacts: string;
const sessions: HarnessSession[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-harness-mcp-'));
  folder = join(root, 'repo');
  library = join(root, 'library');
  artifacts = join(root, 'artifacts');
  await mkdir(join(folder, 'docs'), { recursive: true });
  await mkdir(library, { recursive: true });
  await mkdir(artifacts, { recursive: true });
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(root, { recursive: true, force: true });
});

function connectResponse(overrides: Partial<HarnessConnectResponse> = {}): HarnessConnectResponse {
  return {
    token: 'HARNESS',
    appId: 'harness:claude-code:repo',
    project: { id: 'repo', name: 'repo', workingDir: folder, readOnly: true, created: true },
    libraryDir: library,
    artifactsDir: artifacts,
    memory: 'save',
    images: 'local',
    ...overrides,
  };
}

function fakeGezel(
  response: () => HarnessConnectResponse | Response = () => connectResponse(),
): Fake {
  const fake: Fake = {
    exchanges: [],
    requests: [],
    routes: new Map(),
    connect: async (opts) => {
      const launch: LocalGezelLaunch = {
        key: 'launch-1',
        baseUrl: 'https://gezel.test',
        ownerFetch: async (_path, init) => {
          fake.exchanges.push(JSON.parse(String(init?.body)));
          const out = response();
          return out instanceof Response ? out : Response.json(out);
        },
      };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/health') {
          return Response.json({
            ok: true,
            version: 'test',
            apiCompat: { floor: GEZEL_API_GENERATION_FLOOR, current: GEZEL_API_GENERATION },
          });
        }
        const token = opts.credential ? await opts.credential.token(launch, url) : 'OWNER';
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        fake.requests.push({
          method,
          path: url.pathname + url.search,
          auth: token ? `Bearer ${token}` : null,
          body,
        });
        const handler = fake.routes.get(`${method} ${url.pathname}`);
        if (!handler) return Response.json({ error: 'not found' }, { status: 404 });
        const out = handler(body, url);
        return out instanceof Response ? out : Response.json(out);
      }) as typeof fetch;
      const client = new GezelClient({ baseUrl: launch.baseUrl, token: 'OWNER', fetch: fetchImpl });
      const managed = Object.assign(fetchImpl, {
        close: async () => {},
        destroy: async () => {},
      }) as ManagedFetch;
      return {
        client,
        fetch: managed,
        baseUrl: launch.baseUrl,
        token: 'OWNER',
        launch: () => launch,
        close: async () => {},
      };
    },
  };
  return fake;
}

async function harness(
  fake: Fake,
  opts: Partial<HarnessOptions> = {},
  clientRoots?: string[],
): Promise<Client> {
  const session = new HarnessSession({
    client: 'claude-code',
    cwd: folder,
    connect: fake.connect,
    ...opts,
  });
  sessions.push(session);
  const server = createHarnessServer(session);
  const client = new Client(
    { name: 'harness-test', version: '1.0.0' },
    { capabilities: clientRoots ? { roots: { listChanged: true } } : {} },
  );
  if (clientRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: clientRoots.map((r) => ({ uri: pathToFileURL(r).href })),
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('the harness profile', () => {
  it('lists exactly the profile, with descriptions that name only its own tools', async () => {
    const client = await harness(fakeGezel());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...HARNESS_TOOL_NAMES, ...HARNESS_DOCUMENT_TOOL_NAMES].sort(),
    );
    const others = [
      'write_artifact',
      'read_artifact',
      'invoke_craftbook',
      'grep_files',
      'web_search',
      'fetch_url',
      'read_file',
    ];
    for (const tool of tools) {
      for (const name of others) expect(tool.description, tool.name).not.toContain(name);
    }
  });

  it('parses its arguments and ignores an unsubstituted folder variable', () => {
    expect(parseHarnessArgs(['--harness', 'codex', '--folder', '${workspaceFolder}'])).toEqual(
      expect.objectContaining({ client: 'codex' }),
    );
    expect(parseHarnessArgs(['--harness', 'vscode', '--project', 'p1']).projectId).toBe('p1');
    expect(() => parseHarnessArgs(['--harness', 'emacs'])).toThrow(/--harness needs one of/);
  });
});

describe('binding a folder', () => {
  it('binds the working directory, and sends only the harness token', async () => {
    const fake = fakeGezel();
    fake.routes.set('GET /api/documents', () => ({
      files: [{ name: 'mission.md', path: 'mission.md', isDirectory: false }],
    }));
    const client = await harness(fake);
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    expect(textOf(result)).toContain(join(library, 'mission.md'));
    expect(fake.exchanges).toEqual([{ client: 'claude-code', folder: resolve(folder) }]);
    expect(fake.requests.every((r) => r.auth === 'Bearer HARNESS')).toBe(true);
  });

  it('prefers the folders the client reports over the working directory', async () => {
    const fake = fakeGezel();
    fake.routes.set('GET /api/documents', () => ({ files: [] }));
    const other = join(root, 'other');
    await mkdir(other);
    const client = await harness(fake, {}, [other]);
    await client.callTool({ name: 'list_documents', arguments: {} });
    expect(fake.exchanges).toEqual([{ client: 'claude-code', folder: other }]);
  });

  it('binds a named project, and Claude Desktop binds no folder', async () => {
    const named = fakeGezel();
    named.routes.set('GET /api/documents', () => ({ files: [] }));
    await (await harness(named, { projectId: 'p1' })).callTool({
      name: 'list_documents',
      arguments: {},
    });
    expect(named.exchanges).toEqual([{ client: 'claude-code', projectId: 'p1' }]);

    const desktop = fakeGezel(() => connectResponse({ project: null, unboundReason: 'no-folder' }));
    desktop.routes.set('GET /api/documents', () => ({ files: [] }));
    await (await harness(desktop, { client: 'claude-desktop' })).callTool({
      name: 'list_documents',
      arguments: {},
    });
    expect(desktop.exchanges).toEqual([{ client: 'claude-desktop' }]);
  });

  it('says to open Gezel when it is not running, and passes on a refusal verbatim', async () => {
    const down = await harness({
      ...fakeGezel(),
      connect: async () => {
        throw new DaemonNotRunningError();
      },
    });
    const result = await down.callTool({ name: 'gezel_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Gezel isn't running/);

    const stopped = await harness(
      fakeGezel(() =>
        Response.json(
          { error: 'harness_disconnected', hint: 'Gezel was told to stop this app.' },
          { status: 403 },
        ),
      ),
    );
    const refused = await stopped.callTool({ name: 'gezel_status', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('Gezel was told to stop this app.');
  });
});

describe('the tools', () => {
  it('searches the corpora the settings allow, and answers with absolute paths', async () => {
    const fake = fakeGezel(() => connectResponse({ memory: 'off' }));
    fake.routes.set('POST /api/projects/repo/tools/search', () => ({
      results: [
        {
          kind: 'content',
          id: '1',
          title: 'auth.ts',
          path: 'src/auth.ts',
          retrievalSource: 'workspace',
          line: 4,
          lineEnd: 9,
          snippet: 'token rotation',
          score: 1,
        },
        {
          kind: 'document',
          id: '2',
          title: 'style.md',
          path: 'style.md',
          retrievalSource: 'shared',
          snippet: 'house style',
          score: 0.5,
          tier: 'strong',
        },
        {
          kind: 'document',
          id: '3',
          title: 'About this library.md',
          path: 'About this library.md',
          retrievalSource: 'shared',
          snippet: 'seeded',
          score: 0.4,
          tier: 'weak',
        },
        {
          kind: 'content',
          id: '4',
          title: 'auth.ts',
          path: 'src/auth.ts',
          retrievalSource: 'workspace',
          line: 40,
          lineEnd: 52,
          snippet: 'second chunk',
          score: 0.3,
        },
      ],
      truncated: false,
      craftbooks: [],
    }));
    const client = await harness(fake);
    const out = textOf(
      await client.callTool({ name: 'search', arguments: { query: 'token rotation' } }),
    );
    // One line per file, with every matching range; strong side hits only, after the code.
    expect(out).toContain(`${join(folder, 'src/auth.ts')}:4-9, 40-52`);
    expect(out.match(/auth\.ts/g)).toHaveLength(1);
    expect(out).toContain('Also relevant, outside this folder:');
    expect(out).toContain(join(library, 'style.md'));
    expect(out).not.toContain('About this library');
    const sent = fake.requests.find((r) => r.path.endsWith('/tools/search'))?.body as {
      sources: string[];
      gezelId?: string;
      maxResults: number;
    };
    // Knowledge catalogs are opt-in; memory is off in this binding.
    expect(sent.sources.sort()).toEqual(['artifacts', 'shared', 'workspace']);
    // Ten results by default, fetched three times over since a file's chunks collapse to one entry.
    expect(sent.maxResults).toBe(30);
    expect(sent.gezelId).toBeUndefined();
  });

  it('lists code before the docs that discuss it, and caps the docs', async () => {
    const fake = fakeGezel();
    const doc = (id: string, path: string) => ({
      kind: 'document',
      id,
      title: path,
      path,
      retrievalSource: 'workspace',
      snippet: 'prose',
      score: 1,
    });
    fake.routes.set('POST /api/projects/repo/tools/search', () => ({
      results: [
        doc('d1', 'docs/API.md'),
        doc('d2', 'README.md'),
        doc('d3', 'CLAUDE.md'),
        doc('d4', 'packages/calc/package.json'),
        { ...doc('c1', 'packages/calc/src/dependencyGraph.ts'), kind: 'content', line: 10 },
      ],
      truncated: false,
      craftbooks: [],
    }));
    const client = await harness(fake);
    const out = textOf(await client.callTool({ name: 'search', arguments: { query: 'recalc' } }));
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('dependencyGraph.ts:10');
    expect(out).toContain('Docs in this folder that discuss it:');
    expect(lines).toHaveLength(4);
  });

  it('tells an app that called a tool without its arguments what to send', async () => {
    // trials t1 and t2: Sonnet 5.5 called deferred tools without loading their schemas.
    const fake = fakeGezel();
    const client = await harness(fake);
    const search = await client.callTool({ name: 'search', arguments: {} });
    expect(search.isError).toBe(true);
    expect(textOf(search)).toBe(
      '`search` needs `query` (What to look for, in plain words). For example: {"query":"where uploaded files are checked for size"}',
    );
    expect(fake.requests.some((r) => r.path.endsWith('/tools/search'))).toBe(false);

    const read = await client.callTool({ name: 'read_doc_as_markdown', arguments: {} });
    expect(textOf(read)).toMatch(/^`read_doc_as_markdown` needs `path` \(.+\)\. For example: /);
    expect(textOf(read)).not.toContain('MCP error');
  });

  it('keeps the reason when the arguments are there but wrong', async () => {
    const client = await harness(fakeGezel());
    const result = await client.callTool({ name: 'search', arguments: { query: 42 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^`search` could not use those arguments: .*expected string/);
    expect(textOf(result)).toContain('It needs `query`');
  });

  it('answers a document tool called without its arguments before starting DocBlocks', async () => {
    const fake = fakeGezel();
    const client = await harness(fake);
    const result = await client.callTool({ name: 'convert_document', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^`convert_document` needs `source`.* and `targets`/);
    expect(fake.exchanges).toEqual([]);
  });

  it('names an area summary by its folder, and drops photo matches beside code', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/projects/repo/tools/search', () => ({
      results: [
        {
          kind: 'content',
          id: 'overview:repo:packages',
          title: 'packages/ overview',
          projectId: 'repo',
          projectName: 'repo',
          retrievalSource: 'workspace',
          snippet: 'The packages area holds the calc engine.',
          score: 1,
        },
        {
          kind: 'file',
          id: 'file:repo:art/logo.png',
          title: 'logo.png',
          projectId: 'repo',
          path: 'art/logo.png',
          source: 'workspace',
          retrievalSource: 'workspace',
          media: { modality: 'image', assetPath: 'art/logo.png' },
          score: 0.9,
        },
        {
          kind: 'content',
          id: 'c1',
          title: 'cells.ts',
          projectId: 'repo',
          path: 'src/cells.ts',
          retrievalSource: 'workspace',
          line: 3,
          score: 0.8,
        },
      ],
      truncated: false,
      craftbooks: [],
    }));
    const client = await harness(fake);
    const out = textOf(await client.callTool({ name: 'search', arguments: { query: 'calc' } }));
    expect(out).toContain(`Overview of ${join(folder, 'packages')}`);
    expect(out).toContain('The packages area holds the calc engine.');
    expect(out).not.toContain('repo: packages/ overview');
    expect(out).not.toContain('logo.png');
    expect(out).toContain(`${join(folder, 'src/cells.ts')}:3`);
  });

  it('never shows or opens Gezel’s own Handboek', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/projects/repo/tools/search', () => ({
      results: [
        {
          kind: 'knowledge',
          id: 'h1',
          title: 'Spreadsheets stay spreadsheets',
          uri: 'knowledge://bendyline/handboek/whats-new/1.26247#chunk=abc',
          catalogId: 'handboek',
          retrievalSource: 'knowledge',
          snippet: 'Gezel release notes',
          score: 0.9,
          tier: 'strong',
        },
      ],
      truncated: false,
      craftbooks: [],
    }));
    const client = await harness(fake);
    const found = textOf(
      await client.callTool({
        name: 'search',
        arguments: { query: 'spreadsheets', scopes: ['knowledge'] },
      }),
    );
    expect(found).not.toContain('handboek');
    const named = await client.callTool({
      name: 'search',
      arguments: { query: 'spreadsheets', catalogs: ['handboek'] },
    });
    expect(named.isError).toBe(true);
    const opened = await client.callTool({
      name: 'read_document',
      arguments: { path: 'knowledge://bendyline/handboek/whats-new/1.26247' },
    });
    expect(opened.isError).toBe(true);
    expect(textOf(opened)).toMatch(/not available to other apps/);
  });

  it('reads a relative path from the library, as list_documents names it', async () => {
    // trial t2: `read_document style-guide.md` was looked for in the folder.
    const fake = fakeGezel();
    fake.routes.set('GET /api/documents/read', (_body, url) => ({
      path: url.searchParams.get('path'),
      content: '# House style',
    }));
    const client = await harness(fake);
    const out = await client.callTool({
      name: 'read_document',
      arguments: { path: 'style-guide.md' },
    });
    expect(out.isError).toBeFalsy();
    expect(textOf(out)).toContain('# House style');
    expect(fake.requests.at(-1)?.path).toContain('path=style-guide.md');
  });

  it('searches knowledge only when asked, and then shows it in full', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/projects/repo/tools/search', () => ({
      results: [
        {
          kind: 'knowledge',
          id: 'k1',
          title: 'Haversine formula',
          uri: 'knowledge://wiki/haversine',
          retrievalSource: 'knowledge',
          snippet: 'great-circle distance',
          score: 0.4,
          tier: 'weak',
        },
      ],
      truncated: false,
      craftbooks: [],
    }));
    const client = await harness(fake);
    const out = textOf(
      await client.callTool({
        name: 'search',
        arguments: { query: 'distance on a sphere', scopes: ['knowledge'] },
      }),
    );
    expect(out).toContain('knowledge://wiki/haversine');
    const sent = fake.requests.at(-1)?.body as { sources: string[] };
    expect(sent.sources).toEqual(['knowledge']);
  });

  it('reads an Office file in the folder by its absolute path, and refuses one outside', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/projects/repo/tools/read-doc-as-markdown', (body) => ({
      found: true,
      markdown: `# ${(body as { path: string }).path}`,
      truncated: false,
    }));
    const client = await harness(fake);
    const inside = await client.callTool({
      name: 'read_doc_as_markdown',
      arguments: { path: join(folder, 'docs', 'spec.docx') },
    });
    expect(textOf(inside)).toContain('# docs/spec.docx');
    const outside = await client.callTool({
      name: 'read_doc_as_markdown',
      arguments: { path: join(root, 'elsewhere.docx') },
    });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/is outside/);
  });

  it('saves memories to the project only when saving is allowed', async () => {
    const fake = fakeGezel(() => connectResponse({ memory: 'read' }));
    const readOnly = await harness(fake);
    const refused = await readOnly.callTool({
      name: 'save_memory',
      arguments: { text: 'We ship on Fridays.' },
    });
    expect(refused.isError).toBe(true);

    const saving = fakeGezel();
    saving.routes.set('POST /api/memory/save', () => ({ ok: true, status: 'saved' }));
    const client = await harness(saving);
    const saved = await client.callTool({
      name: 'save_memory',
      arguments: { text: 'We ship on Fridays.' },
    });
    expect(textOf(saved)).toBe('Saved.');
    expect(saving.requests.at(-1)?.body).toEqual({
      scope: 'project',
      id: 'repo',
      text: 'We ship on Fridays.',
      kind: 'fact',
    });
  });

  it('returns a generated image with the path Gezel saved it to', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/image-gen/generate', () => ({
      artifactPath: 'generated/cat.png',
      workspacePath: null,
      b64Png: 'iVBORw0KGgo=',
      meta: { model: 'sdxl', seed: 1, widthPx: 64, heightPx: 64 },
    }));
    const client = await harness(fake);
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'a cat' },
    });
    const content = result.content as Array<{ type: string; data?: string; text?: string }>;
    expect(content[0]).toMatchObject({ type: 'image', data: 'iVBORw0KGgo=' });
    expect(textOf(result)).toContain(join(artifacts, 'generated/cat.png'));
    const sent = fake.requests.at(-1)?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ prompt: 'a cat', projectId: 'repo', inline: true });
    expect(sent.saveAs).toBeUndefined();
  });

  it('says when the image engine made a new image instead of the edit asked for', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/image-gen/generate', () => ({
      artifactPath: 'generated/van.png',
      workspacePath: null,
      meta: {
        model: 'flux-2-klein-4b-q4',
        seed: 1,
        widthPx: 64,
        heightPx: 64,
        img2imgSkippedReason: 'model flux-2-klein-4b-q4 does not support image editing (img2img)',
      },
    }));
    await writeFile(join(folder, 'van.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = await harness(fake);
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'remove the logo', inputImages: ['van.png'] },
    });
    expect(textOf(result)).toMatch(/can't edit images .* made a new image from the prompt alone/);
  });

  it('forwards image settings and references, and surfaces provider adjustments', async () => {
    const fake = fakeGezel(() => connectResponse({ images: 'any' }));
    fake.routes.set('POST /api/image-gen/generate', () => ({
      artifactPath: 'generated/cat.png',
      workspacePath: null,
      meta: {
        model: 'copilot-image',
        seed: 0,
        widthPx: 1536,
        heightPx: 1024,
        settingsNotes: ['Requested 16:9; used 1536x1024.'],
      },
    }));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(folder, 'cat.png'), bytes);
    const client = await harness(fake);
    const result = await client.callTool({
      name: 'generate_image',
      arguments: {
        prompt: 'A cat on a boat',
        aspectRatio: '16:9',
        quality: 'high',
        negativePrompt: 'text',
        inputImages: ['cat.png'],
      },
    });
    expect(fake.requests.at(-1)?.body).toMatchObject({
      prompt: 'A cat on a boat',
      aspectRatio: '16:9',
      quality: 'high',
      negativePrompt: 'text',
      inputImages: [{ data: bytes.toString('base64'), mimeType: 'image/png' }],
    });
    expect(textOf(result)).toContain('Requested 16:9; used 1536x1024.');
  });

  it('describes an image in the folder from its bytes, never one outside it', async () => {
    const fake = fakeGezel();
    fake.routes.set('POST /api/recognition/describe', () => ({
      status: 'ok',
      meta: { format: 'png', width: 2, height: 2, byteLength: 4 },
      description: 'A tiny square.',
    }));
    await writeFile(join(folder, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = await harness(fake);
    const inside = await client.callTool({
      name: 'describe_image',
      arguments: { path: 'shot.png' },
    });
    expect(textOf(inside)).toContain('A tiny square.');
    const sent = fake.requests.at(-1);
    expect(sent?.path).toBe('/api/recognition/describe?project=repo');
    expect((sent?.body as { data: string }).data).toBe(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    );

    await writeFile(join(root, 'secret.png'), 'x');
    const outside = await client.callTool({
      name: 'describe_image',
      arguments: { path: join(root, 'secret.png') },
    });
    expect(outside.isError).toBe(true);
  });
});

describe("the night shift's issues", () => {
  const batch = {
    files: [
      {
        path: 'src/save.ts',
        issues: [
          {
            ref: 'BW-4',
            severity: 'major',
            category: 'bug',
            message: 'The loop stops one item early.',
            line: 12,
            stale: false,
          },
          {
            ref: 'BW-9',
            severity: 'minor',
            category: 'smell',
            message: 'A long function.',
            line: 40,
            stale: true,
          },
        ],
      },
    ],
    count: 2,
    remaining: 7,
    firstBatch: true,
    indexed: true,
  };

  function withIssues(fake: Fake) {
    fake.routes.set('POST /api/projects/repo/tools/issue-handoff', () => batch);
    fake.routes.set('POST /api/projects/repo/tools/issue-verdicts', () => ({
      results: [
        { ref: 'BW-4', outcome: 'applied', message: 'BW-4 is now open.' },
        { ref: 'BW-9', outcome: 'refused', message: 'BW-9 is being worked on in task repo/3.' },
      ],
      applied: 1,
      refused: 1,
    }));
    return fake;
  }

  it('lists issues with absolute paths and says which lines moved', async () => {
    const fake = withIssues(fakeGezel(() => connectResponse({ issues: 'triage' })));
    const client = await harness(fake);
    const out = textOf(await client.callTool({ name: 'list_issues', arguments: { limit: 5 } }));
    expect(out).toContain(join(folder, 'src/save.ts'));
    expect(out).toContain('BW-4 · major · bug · line 12: The loop stops one item early.');
    expect(out).toContain('was line 40; the file changed since the review');
    expect(out).toContain('7 more waiting');
    expect(fake.requests.at(-1)).toMatchObject({ auth: 'Bearer HARNESS', body: { limit: 5 } });
  });

  it('reports verdicts in the daemon shape and repeats what was refused', async () => {
    const fake = withIssues(fakeGezel(() => connectResponse({ issues: 'triage' })));
    const client = await harness(fake);
    const out = textOf(
      await client.callTool({
        name: 'report_issue_verdicts',
        arguments: {
          verdicts: [
            { ref: 'BW-4', verdict: 'confirmed', note: 'Reproduced with three rows.' },
            { ref: 'BW-9', verdict: 'nit', note: 'True but harmless.', reason: 'intended' },
          ],
        },
      }),
    );
    expect(out).toContain('Gezel recorded 1 verdict; 1 refused.');
    expect(out).toContain('BW-9: BW-9 is being worked on in task repo/3.');
    expect(fake.requests.at(-1)?.body).toEqual({
      verdicts: [
        { ref: 'BW-4', kind: 'confirmed', note: 'Reproduced with three rows.' },
        { ref: 'BW-9', kind: 'nit', note: 'True but harmless.' },
      ],
    });
  });

  it('says so when the person turned verdicts or issues off', async () => {
    const read = await harness(withIssues(fakeGezel(() => connectResponse({ issues: 'read' }))));
    const refused = await read.callTool({
      name: 'report_issue_verdicts',
      arguments: { verdicts: [{ ref: 'BW-4', verdict: 'fixed', note: 'Fixed the bound.' }] },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('Reporting verdicts is turned off');

    const off = await harness(withIssues(fakeGezel(() => connectResponse({ issues: 'off' }))));
    const listed = await off.callTool({ name: 'list_issues', arguments: {} });
    expect(listed.isError).toBe(true);
  });

  it('asks for an update when the daemon predates issue triage', async () => {
    const client = await harness(withIssues(fakeGezel(() => connectResponse())));
    const res = await client.callTool({ name: 'list_issues', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Update Gezel');
  });

  it('serves the triage and fix prompts with the batch embedded', async () => {
    const fake = withIssues(fakeGezel(() => connectResponse({ issues: 'triage' })));
    const client = await harness(fake);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['fix_issues', 'triage_issues']);

    const triage = await client.getPrompt({ name: 'triage_issues', arguments: { count: '3' } });
    const text = (triage.messages[0]?.content as { text: string }).text;
    expect(text).toContain("Don't change any code");
    expect(text).toContain('nit, not not_a_bug');
    expect(text).toContain('BW-4 · major · bug · line 12');
    expect(fake.requests.at(-1)?.body).toEqual({ limit: 3 });

    const fix = await client.getPrompt({ name: 'fix_issues', arguments: {} });
    expect((fix.messages[0]?.content as { text: string }).text).toContain(
      'Fix what is real and small',
    );
    expect(fake.requests.at(-1)?.body).toEqual({ limit: 5, mode: 'fix' });
  });

  it('says only that there is nothing to check when the batch is empty', async () => {
    const fake = withIssues(fakeGezel(() => connectResponse({ issues: 'triage' })));
    fake.routes.set('POST /api/projects/repo/tools/issue-handoff', () => ({
      ...batch,
      files: [],
      count: 0,
      remaining: 0,
    }));
    const client = await harness(fake);
    const triage = await client.getPrompt({ name: 'triage_issues', arguments: {} });
    const text = (triage.messages[0]?.content as { text: string }).text;
    expect(text).toMatch(/^Gezel has no open issues/);
    expect(text).not.toContain('report_issue_verdicts');
  });
});

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
/** The DocBlocks the service ships, when this checkout has it installed. */
const docblocksEntry = (() => {
  try {
    const pkg = createRequire(join(repoRoot, 'packages/service/package.json')).resolve(
      '@bendyline/docblocks-cli/package.json',
    );
    const entry = join(pkg, '..', 'dist', 'bin.js');
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
})();

/** The first artifact address in a DocBlocks result. */
function artifactUri(result: Awaited<ReturnType<Client['callTool']>>): string {
  const match = /docblocks:\/\/artifacts\/[A-Za-z0-9._:-]+/.exec(JSON.stringify(result));
  if (!match) throw new Error(`no artifact in ${textOf(result)}`);
  return match[0];
}

describe('making documents', () => {
  it("lists DocBlocks' schemas, with a save that needs only a file name", async () => {
    const { tools } = await (await harness(fakeGezel())).listTools();
    const convert = tools.find((t) => t.name === 'convert_document');
    expect(convert?.inputSchema.required).toEqual(['source', 'targets']);
    expect(convert?.description).toContain('one `#` heading per slide');
    const save = tools.find((t) => t.name === 'save_artifact');
    const destination = (save?.inputSchema.properties as Record<string, { required?: string[] }>)
      .destination;
    expect(destination?.required).toEqual(['path']);
  });

  it('tells an app on an older Gezel to update', async () => {
    const client = await harness(fakeGezel());
    const result = await client.callTool({
      name: 'convert_document',
      arguments: { source: { kind: 'markdown', markdown: '# Hi' }, targets: ['docx'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Update Gezel');
  });

  it.skipIf(!docblocksEntry)(
    "converts a file in the folder and saves it in Gezel's folder, never the app's",
    async () => {
      await writeFile(join(folder, 'docs', 'brief.md'), '# Pilot\n\nResults improved.\n');
      const fake = fakeGezel(() => connectResponse({ documents: { entry: docblocksEntry! } }));
      const client = await harness(fake);
      const converted = await client.callTool({
        name: 'convert_document',
        arguments: { source: join(folder, 'docs', 'brief.md'), targets: ['docx'] },
      });
      expect(converted.isError, textOf(converted)).toBeFalsy();
      const saved = await client.callTool({
        name: 'save_artifact',
        arguments: { artifactUri: artifactUri(converted), destination: { path: 'brief.docx' } },
      });
      expect(saved.isError, textOf(saved)).toBeFalsy();
      const file = join(artifacts, 'documents', 'brief.docx');
      expect(textOf(saved)).toContain(`Saved to ${file}`);
      expect((await readFile(file)).subarray(0, 2).toString()).toBe('PK');
      expect(existsSync(join(folder, 'brief.docx'))).toBe(false);
      // The same name again (the deck made twice) is numbered, not refused.
      const again = await client.callTool({
        name: 'save_artifact',
        arguments: { artifactUri: artifactUri(converted), destination: { path: 'brief.docx' } },
      });
      expect(again.isError, textOf(again)).toBeFalsy();
      expect(textOf(again)).toContain('so this one is named brief (2).docx');
      expect(existsSync(join(artifacts, 'documents', 'brief (2).docx'))).toBe(true);
      // Claude Code shows structuredContent instead of content, which hid the note.
      expect(again.structuredContent).toBeUndefined();
      // A replace needs the current file's hash, which Gezel reads for the app.
      const replaced = await client.callTool({
        name: 'save_artifact',
        arguments: {
          artifactUri: artifactUri(converted),
          destination: { path: 'brief.docx', ifExists: 'replace' },
        },
      });
      expect(replaced.isError, textOf(replaced)).toBeFalsy();
      expect(textOf(replaced)).toContain(`Saved to ${file}`);
    },
    60_000,
  );

  it.skipIf(!docblocksEntry)(
    'keeps the snapshot in step with the DocBlocks the service ships',
    async () => {
      const snapshot = JSON.parse(
        await readFile(join(repoRoot, 'packages/mcp/src/harness/docblocks-tools.json'), 'utf8'),
      ) as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      const client = new Client({ name: 'snapshot-test', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [docblocksEntry!, 'mcp'] }),
      );
      try {
        const { tools } = await client.listTools();
        for (const expected of snapshot.tools) {
          const live = tools.find((t) => t.name === expected.name);
          // Out of step: run `node scripts/snapshot-docblocks-tools.mjs`.
          expect(live?.description, expected.name).toBe(expected.description);
          expect(live?.inputSchema, expected.name).toEqual(expected.inputSchema);
        }
      } finally {
        await client.close();
      }
    },
    60_000,
  );
});
