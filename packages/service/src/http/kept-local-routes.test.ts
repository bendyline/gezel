import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeptLocalSource } from '@bendyline/gezel';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { ServiceContext } from './context.js';
import { connectorRoutes } from './routes/connectors.js';
import { projectRoutes } from './routes/projects.js';
import { referencePreviewRoutes } from './routes/reference-preview.js';
import { reportActionRoutes } from './routes/report-actions.js';
import { toolRoutes } from './routes/tools.js';

// A Google calendar is kept on models on this computer until the person
// allows cloud ones. A route that opens artifacts and forgets to ask hands a
// cloud model the event it was asked not to send, so every one is here.

const EVENT = 'data/work/2026-11/003--dentist.md';
const SECRET = 'Dentist, root canal';
const REPORT = 'reports/plan.md';

let home: string;
let store: Store;
let projectId: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-kept-routes-'));
  store = new Store({ home });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'Week' })).id;
  await bindCalendar({});
  const root = store.projectArtifactsDir(projectId);
  for (const [path, text] of [
    [EVENT, `# ${SECRET}\n`],
    [REPORT, '# Plan\n'],
    ['data/news/item.md', '# News\n'],
  ] as const) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function bindCalendar(extra: { allowCloudModels?: boolean }): Promise<void> {
  await store.updateProject(projectId, {
    connectors: [
      {
        id: 'calendar-google:ab12',
        type: 'calendar-google',
        displayName: 'Work',
        corpusDir: 'data/work',
        account: 'sam@example.com',
        config: {},
        ...extra,
      },
      { id: 'news', type: 'rss-feed', corpusDir: 'data/news', config: {} },
    ],
  });
}

type Caller = 'person' | 'cloud' | 'local' | 'outside-app' | 'app-grant';

const AUTH: Record<Caller, { appId: string; scopes: string[]; gezelId?: string }> = {
  person: { appId: 'desktop', scopes: ['ui'] },
  cloud: { appId: 'session:cloud', scopes: ['session'], gezelId: 'ada' },
  local: { appId: 'session:local', scopes: ['session'], gezelId: 'leo' },
  'outside-app': { appId: 'harness:claude-code', scopes: ['harness'] },
  'app-grant': { appId: 'some-app', scopes: ['openai'] },
};

function as(caller: Caller, opts: { kept?: KeptLocalSource[] } = {}) {
  const marked: KeptLocalSource[][] = [];
  const searchOpts: Array<Record<string, unknown>> = [];
  const ctx = {
    home,
    store,
    chat: {
      sessionRunsOnThisComputer: async (id: string) => id === 'local',
      markKeptLocal: async (_id: string, sources: KeptLocalSource[]) => {
        marked.push(sources);
      },
      markKeptLocalTags: async () => {},
      keptLocalSources: async () => opts.kept ?? [],
      getSessionRecord: async () => null,
    },
    history: { log: async () => {} },
    catalog: { list: async () => [] },
    git: {},
    contentIndex: {
      readDocAsMarkdown: vi.fn(async () => ({ found: true, markdown: SECRET })),
    },
    reportActions: { listForReport: vi.fn(async () => ({ actions: [SECRET] })) },
    connectors: {
      status: async () => ({
        configured: true,
        bindings: [
          {
            id: 'calendar-google:ab12',
            type: 'calendar-google',
            account: 'sam@example.com',
            allowCloudModels: false,
          },
        ],
      }),
    },
    connectorActions: {
      list: async () => ({
        pending: [
          { draftId: 'd1', bindingId: 'calendar-google:ab12', input: SECRET },
          { draftId: 'd2', bindingId: 'news', input: 'fine' },
        ],
      }),
    },
    search: {
      searchProject: async (_q: string, o: Record<string, unknown>) => {
        searchOpts.push(o);
        const omit = o.omitArtifact as ((p: string, path: string) => boolean) | undefined;
        const results = [
          { id: 'a', retrievalSource: 'artifacts', projectId, path: EVENT, snippet: SECRET },
          { id: 'b', retrievalSource: 'artifacts', projectId, path: 'data/news/item.md' },
        ].filter((r) => !omit?.(r.projectId, r.path));
        return { results, truncated: false };
      },
    },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', AUTH[caller] as never);
    await next();
  });
  for (const routes of [
    projectRoutes,
    toolRoutes,
    referencePreviewRoutes,
    reportActionRoutes,
    connectorRoutes,
  ]) {
    app.route('/', routes(ctx));
  }
  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(`/${projectId}${path}`, init);
    return { status: res.status, text: await res.text() };
  };
  return {
    marked,
    searchOpts,
    get: (path: string) => request(path),
    post: (path: string, body: unknown, method = 'POST') =>
      request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

const q = encodeURIComponent;

/** Every read of one event, and what a caller that may see it is answered. */
const READS: Array<
  [string, (c: ReturnType<typeof as>) => Promise<{ status: number; text: string }>]
> = [
  ['read', (c) => c.get(`/artifacts/read?path=${q(EVENT)}`)],
  ['raw read', (c) => c.get(`/artifacts/read?raw=1&path=${q(EVENT)}`)],
  ['read spelled another way', (c) => c.get(`/artifacts/read?path=${q(`reports/../${EVENT}`)}`)],
  ['slice', (c) => c.get(`/artifacts/slice?path=${q(EVENT)}`)],
  ['slice by bare name', (c) => c.get(`/artifacts/slice?path=${q('003--dentist.md')}`)],
  ['resolve', (c) => c.get(`/artifacts/resolve?path=${q(EVENT)}`)],
  ['grep', (c) => c.post('/artifacts/grep', { path: EVENT, pattern: 'Dentist' })],
  ['reference preview', (c) => c.get(`/reference-preview?kind=artifact&path=${q(EVENT)}`)],
  [
    'read as markdown',
    (c) => c.post('/tools/read-doc-as-markdown', { path: EVENT, artifact: true }),
  ],
  ['report actions', (c) => c.get(`/report-actions?path=${q(EVENT)}`)],
  ['search', (c) => c.post('/tools/search', { query: 'dentist' })],
  ['connection drafts', (c) => c.get('/connectors/actions')],
];

describe('reading a kept connection', () => {
  it.each(READS)('%s: the person and a gezel on a local model see it', async (_name, read) => {
    for (const caller of ['person', 'local'] as const) {
      const answer = await read(as(caller));
      expect(answer.status, caller).toBe(200);
      expect(answer.text, caller).toContain('entist');
    }
  });

  it.each(READS)('%s: a cloud gezel and an app Gezel cannot see do not', async (_name, read) => {
    for (const caller of ['cloud', 'outside-app', 'app-grant'] as const) {
      const answer = await read(as(caller));
      expect(answer.text, caller).not.toContain(SECRET);
      expect(answer.text, caller).not.toContain('root canal');
    }
  });

  it.each(READS)('%s: a cloud gezel sees it once the person allows it', async (_name, read) => {
    await bindCalendar({ allowCloudModels: true });
    const answer = await read(as('cloud'));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('entist');
  });

  it.each(READS.filter(([name]) => name !== 'connection drafts'))(
    '%s: marks the conversation of a gezel on a local model',
    async (_name, read) => {
      const local = as('local');
      await read(local);
      expect(local.marked.flat().map((s) => s.name)).toContain('Work');
      const person = as('person');
      await read(person);
      expect(person.marked).toEqual([]);
    },
  );

  it('tells a cloud gezel why, and what the person can do', async () => {
    const refused = await as('cloud').get(`/artifacts/read?path=${q(EVENT)}`);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('Work stays on this computer');
    expect(refused.text).toContain('Let cloud AI read this');
  });

  it('does not confirm a name a cloud gezel guessed', async () => {
    const answer = await as('cloud').get(`/artifacts/slice?path=${q('003--dentist.md')}`);
    expect(JSON.parse(answer.text)).toEqual({ kind: 'missing' });
  });
});

describe('listing', () => {
  const names = async (caller: Caller, query: string) =>
    (
      JSON.parse((await as(caller).get(`/artifacts${query}`)).text) as {
        files: { path: string }[];
      }
    ).files.map((f) => f.path);

  it('leaves a kept folder out for a cloud gezel and nothing else', async () => {
    expect(await names('cloud', '?recursive=1')).not.toContain(EVENT);
    expect(await names('cloud', '?recursive=1')).toContain('data/news/item.md');
    expect(await names('cloud', '?path=data')).toEqual(['data/news']);
    expect(await names('cloud', '?path=data/work')).toEqual([]);
    expect(await names('local', '?recursive=1')).toContain(EVENT);
    expect(await names('person', '?recursive=1')).toContain(EVENT);
  });
});

describe('what leaves a kept folder', () => {
  it('cannot be copied to the workspace by a cloud gezel', async () => {
    const copy = await as('cloud').post('/workspace/copy-from-artifact', {
      source: EVENT,
      dest: 'event.md',
    });
    expect(copy.status).toBe(403);
    expect(
      await store.readProjectWorkspaceFile(projectId, 'event.md').catch(() => null),
    ).toBeNull();
  });

  it('is remembered when a conversation that read it writes a file', async () => {
    const kept = [{ projectId, bindingId: 'calendar-google:ab12', name: 'Work' }];
    const local = as('local', { kept });
    await local.post('/artifacts/write', { path: 'reports/week.md', content: SECRET }, 'PUT');
    expect((await as('cloud').get('/artifacts/read?path=reports/week.md')).status).toBe(403);
    expect((await as('local').get('/artifacts/read?path=reports/week.md')).status).toBe(200);

    // Renaming it does not free it, whoever renames it.
    await as('person').post('/artifacts/rename', {
      fromPath: 'reports/week.md',
      toPath: 'reports/renamed.md',
    });
    expect((await as('cloud').get('/artifacts/read?path=reports/renamed.md')).status).toBe(403);
    expect(
      (
        await as('cloud').post('/artifacts/rename', {
          fromPath: 'reports/renamed.md',
          toPath: 'reports/free.md',
        })
      ).status,
    ).toBe(403);
  });

  it('is not remembered when an ordinary conversation writes one', async () => {
    await as('local').post('/artifacts/write', { path: REPORT, content: 'x' }, 'PUT');
    expect((await as('cloud').get(`/artifacts/read?path=${REPORT}`)).status).toBe(200);
  });

  it('keeps whose account it is from a cloud gezel', async () => {
    expect((await as('cloud').get('/connectors')).text).not.toContain('sam@example.com');
    expect((await as('person').get('/connectors')).text).toContain('sam@example.com');
  });
});

describe('search', () => {
  it('asks for kept memories to be left out only where the model is elsewhere', async () => {
    const cloud = as('cloud');
    await cloud.post('/tools/search', { query: 'dentist' });
    expect(cloud.searchOpts[0]).toMatchObject({ omitKeptLocalMemory: true });
    const local = as('local');
    await local.post('/tools/search', { query: 'dentist' });
    expect(local.searchOpts[0]).not.toHaveProperty('omitKeptLocalMemory');
  });
});
