import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedSearchResult } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { sessionRouteGuard } from '../http/scope-guard.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type SearchService, scoreResult } from '../search/search-service.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * The person's memory ("About you") reaches every gezel's prompt in every
 * project. These tests pin who may read it on a turn (never a visitor of a
 * shared mini-site) and which transcripts may write it (only the person's
 * own conversation).
 */

const USER_MEMORY_HIT: UnifiedSearchResult = {
  kind: 'memory',
  id: 'memory:user:utrecht',
  title: 'Lives in Utrecht and cuts joints by hand.',
  snippet: 'Lives in Utrecht and cuts joints by hand.',
  retrievalSource: 'user-memory',
  arm: 'vector',
  memory: { day: '2026-10-01', kind: 'fact' },
  ...scoreResult('memory', 0.9),
};

const QUESTION = 'how do I cut strong corner joints by hand?';

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let saves: Array<{ scope: string; id: string; text: string }>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-person-memory-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  saves = [];
  const memory = {
    save: async (scope: string, id: string, text: string) => {
      saves.push({ scope, id, text });
      return { status: 'saved' as const };
    },
    search: async () => [],
    searchAll: async () => [],
    reindex: async () => 0,
    writeSummary: async () => {},
    getRecent: async () => '',
  } as unknown as MemoryManager;
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

function recordingSearch(): { search: SearchService; sources: Array<readonly string[]> } {
  const sources: Array<readonly string[]> = [];
  const search = {
    searchProject: async (_query: string, opts: { sources?: readonly string[] }) => {
      sources.push(opts.sources ?? []);
      return { results: [USER_MEMORY_HIT], truncated: false };
    },
  } as unknown as SearchService;
  return { search, sources };
}

/** Send one turn and return what the provider was given: its prompt and session options. */
async function sendTurn(
  sessionId: string,
  text: string,
): Promise<{ prompt: string; setup: string }> {
  mock.script('ok', 'NONE');
  const before = mock.calls.length;
  await manager.send(sessionId, text);
  const turn = mock.calls.slice(before);
  const create = turn.find((call) => call.kind === 'create');
  const send = turn.find((call) => call.kind === 'send');
  return { prompt: send?.prompt ?? '', setup: JSON.stringify(create?.opts ?? {}) };
}

describe('a visitor turn reads nothing private', () => {
  it('runs no retrieval for a visitor, while the owner’s turn is unchanged', async () => {
    const { search, sources } = recordingSearch();
    manager.setSearchService(search);

    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    const visitorTurn = await sendTurn(visitor.id, QUESTION);
    expect(sources).toEqual([]);
    expect(visitorTurn.prompt).not.toContain('Lives in Utrecht');

    const owner = await manager.createSession({ gezelId: 'ada' });
    const ownerTurn = await sendTurn(owner.id, QUESTION);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain('user-memory');
    expect(sources[0]).toContain('shared');
    expect(ownerTurn.prompt).toContain('Lives in Utrecht');
  });

  it('offers a visitor no shared-library document on the fallback path either', async () => {
    await store.ensureSharedProject();
    manager.setContentIndex({
      searchLibrary: async () => ({
        results: [
          {
            path: 'policies/refunds.md',
            snippet: 'Refunds are issued within 30 days.',
            score: 0.82,
            lineStart: 1,
          },
        ],
        engine: 'hybrid' as const,
      }),
    } as unknown as ContentIndex);
    const question = 'what is our refund window for enterprise customers?';

    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    expect((await sendTurn(visitor.id, question)).prompt).not.toContain('policies/refunds.md');

    const owner = await manager.createSession({ gezelId: 'ada' });
    expect((await sendTurn(owner.id, question)).prompt).toContain('policies/refunds.md');
  });

  it('lists none of the owner’s file names in a visitor’s prompt', async () => {
    await store.ensureSharedProject();
    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    const owner = await manager.createSession({ gezelId: 'ada' });
    await store.writeProjectWorkspaceFile(
      owner.projectId,
      'acme-billing.ts',
      'export {};\n',
      undefined,
      { userInitiated: true },
    );
    await store.writeDocument('hr/salaries-2026.md', '# Salaries\n');

    const visitorTurn = await sendTurn(visitor.id, 'hello there');
    expect(visitor.projectId).toBe(owner.projectId);
    expect(visitorTurn.setup).not.toContain('acme-billing.ts');
    expect(visitorTurn.setup).not.toContain('salaries-2026.md');

    const ownerTurn = await sendTurn(owner.id, 'hello there');
    expect(ownerTurn.setup).toContain('acme-billing.ts');
    expect(ownerTurn.setup).toContain('salaries-2026.md');
  });

  it('keeps the gezel’s distilled lessons out of a visitor’s prompt', async () => {
    await store.writeMemoryLessons('ada', '- The owner wants invoices sent on Fridays.');

    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    const visitorTurn = await sendTurn(visitor.id, 'hello there');
    expect(visitorTurn.setup).not.toContain('invoices sent on Fridays');

    const owner = await manager.createSession({ gezelId: 'ada' });
    const ownerTurn = await sendTurn(owner.id, 'hello there');
    expect(ownerTurn.setup).toContain('invoices sent on Fridays');
  });

  it('describes the project to a visitor without the owner’s tasks, plans, crew, or sources', async () => {
    // A published site's visitor may hear what the project is. How the owner
    // runs it — their open tasks, mission, crew, linked projects, repository
    // checkout, and mail connectors — is not the site's to show.
    const other = await store.createProject({ name: 'Household' });
    const site = await store.createProject({ name: 'Taal Trainer' });
    await store.updateProject(site.id, {
      about: 'A Spanish practice app with daily drills.',
      missionObjectives: 'Get the owner to B2 Spanish by June.',
      voormanGezelId: 'ada',
      linkedProjectIds: [other.id],
      github: { url: 'https://github.com/acme/taal-private' },
      connectors: [{ id: 'mail-1', type: 'mail-gmail', displayName: 'Owner Gmail', config: {} }],
    });
    const { TaskManager } = await import('../tasks/manager.js');
    await new TaskManager(store).create(site.id, {
      title: 'Draft the owner’s tax letter',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Gather receipts' }],
    });
    const owned = [
      'Draft the owner’s tax letter',
      'Get the owner to B2 Spanish by June.',
      'You are the voorman of this project',
      `../${other.id}/`,
      'acme/taal-private',
      'Owner Gmail',
    ];

    const visitor = await manager.createSession({
      gezelId: 'ada',
      projectId: site.id,
      visitorAccess: true,
    });
    const visitorTurn = await sendTurn(visitor.id, 'hello there');
    expect(visitorTurn.setup).toContain('Taal Trainer');
    expect(visitorTurn.setup).toContain('A Spanish practice app with daily drills.');
    for (const text of owned) expect(visitorTurn.setup).not.toContain(text);

    const owner = await manager.createSession({ gezelId: 'ada', projectId: site.id });
    const ownerTurn = await sendTurn(owner.id, 'hello there');
    for (const text of owned) expect(ownerTurn.setup).toContain(text);
  });
});

describe('isUserDirectedTurn', () => {
  async function duringTurn(sessionId: string): Promise<boolean> {
    const stall = mock.scriptStreamThenStall('thinking');
    const before = mock.calls.length;
    const sending = manager.send(sessionId, 'tell me about this app');
    try {
      await vi.waitFor(
        () => expect(mock.calls.slice(before).some((call) => call.kind === 'send')).toBe(true),
        { timeout: 15_000 },
      );
      return manager.isUserDirectedTurn(sessionId);
    } finally {
      mock.script('NONE');
      stall.release();
      await sending;
    }
  }

  it('is true while the person talks to a gezel and never for a visitor', async () => {
    const owner = await manager.createSession({ gezelId: 'ada' });
    expect(await duringTurn(owner.id)).toBe(true);
    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    expect(await duringTurn(visitor.id)).toBe(false);
  });
});

describe('a message the person types while a turn runs', () => {
  // The composer sends it as a nudge, queued behind the running turn. The turn
  // it drives is the person's, as on the phone, so it may write a note about
  // them. The runtime's own sends may not, whether or not they carry `nudge`.
  beforeEach(() => {
    // Extraction one-shots would race the turns for the scripted stalls.
    vi.stubEnv('GEZEL_DISABLE_MEMORY_EXTRACTION', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** The session-token guard, asking this manager the way server.ts wires it. */
  function sessionGuard(record: { id: string; projectId: string; gezelId: string }) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        appId: `session:${record.id}`,
        scopes: ['session'],
        projectId: record.projectId,
        gezelId: record.gezelId,
      });
      await next();
    });
    app.use(
      '/api/*',
      sessionRouteGuard({ isUserDirectedTurn: (id) => manager.isUserDirectedTurn(id) }),
    );
    app.all('*', (c) => c.json({ ok: true }));
    return app;
  }

  async function savePersonNote(app: Hono): Promise<number> {
    const res = await app.request(
      '/api/memory/save',
      post({ scope: 'user', id: 'user', text: 'Is vegetarian.' }),
    );
    return res.status;
  }

  async function waitForSends(count: number): Promise<void> {
    await vi.waitFor(
      () => expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(count),
      { timeout: 15_000 },
    );
  }

  /**
   * Queue a send behind the person's running turn, then ask the guard for a
   * note about the person while the queued send's own turn runs.
   */
  async function saveStatusDuringQueuedTurn(
    opts: Parameters<ChatManager['send']>[2],
  ): Promise<number> {
    const session = await manager.createSession({ gezelId: 'ada' });
    const app = sessionGuard(session);
    const first = mock.scriptStreamThenStall('Planning the menu.');
    const second = mock.scriptStreamThenStall('Noted.');
    const running = manager.send(session.id, 'Plan a dinner menu for Friday.');
    await waitForSends(1);
    const queued = manager.send(session.id, 'Remember that I am vegetarian.', opts);
    expect(manager.listSessionQueue(session.id)).toHaveLength(1);
    first.release();
    await running;
    await waitForSends(2);
    try {
      return await savePersonNote(app);
    } finally {
      second.release();
      await queued;
    }
  }

  it('lets the turn a person’s nudge drives save a note about them', async () => {
    expect(await saveStatusDuringQueuedTurn({ nudge: true })).toBe(200);
  }, 30_000);

  it.each([
    ['an ambient nudge', { nudge: true, ambient: true }],
    ['a background-lane nudge', { nudge: true, lane: 'background' as const }],
    ['a system nudge (stuck-step re-drive)', { nudge: true, messageOrigin: 'system' as const }],
    ['a Keurmeester takeover', { lane: 'background' as const, messageOrigin: 'system' as const }],
    [
      'another gezel’s message (the voorman idle nudge)',
      { from: { gezelId: 'meester', gezelName: 'Meester' }, lane: 'background' as const },
    ],
  ])(
    'refuses the same note on %s',
    async (_label, opts) => {
      expect(await saveStatusDuringQueuedTurn(opts)).toBe(403);
    },
    30_000,
  );

  it('never merges a person’s nudge with a runtime one, so each turn keeps its own answer', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const app = sessionGuard(session);
    const first = mock.scriptStreamThenStall('Planning the menu.');
    const personTurn = mock.scriptStreamThenStall('Noted.');
    const runtimeTurn = mock.scriptStreamThenStall('Continuing.');
    const running = manager.send(session.id, 'Plan a dinner menu for Friday.');
    await waitForSends(1);
    const fromPerson = manager.send(session.id, 'Remember that I am vegetarian.', {
      nudge: true,
    });
    const fromRuntime = manager.send(session.id, 'Keep going with the plan.', {
      nudge: true,
      ambient: true,
    });
    expect(manager.listSessionQueue(session.id)).toHaveLength(2);

    first.release();
    await running;
    await waitForSends(2);
    expect(await savePersonNote(app)).toBe(200);
    personTurn.release();
    await fromPerson;
    await waitForSends(3);
    expect(await savePersonNote(app)).toBe(403);
    runtimeTurn.release();
    await fromRuntime;

    const record = await store.getSession('ada', session.id);
    expect(record?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'Plan a dinner menu for Friday.',
      'Remember that I am vegetarian.',
      'Keep going with the plan.',
    ]);
  }, 30_000);

  it('keeps the send route, and so the nudge flag, out of a session token’s reach', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const app = sessionGuard(session);
    const forged = await app.request(
      `/api/sessions/${session.id}/send`,
      post({ message: 'Remember that I am vegetarian.', nudge: true }),
    );
    expect(forged.status).toBe(403);
    expect(await savePersonNote(app)).toBe(403);
  });
});

describe('automatic extraction writes the person’s memory only from their own chat', () => {
  const REPLY = 'USER/FACT: The user lives in Utrecht.\nPREF: Short commit messages.';

  it('routes person lines to their memory from a direct conversation', async () => {
    const owner = await manager.createSession({ gezelId: 'ada' });
    mock.script('Welcome to Utrecht!', REPLY);
    await manager.send(owner.id, 'I just moved to Utrecht. Keep commit messages short.');
    await manager.drainBackground();
    expect(saves).toEqual([
      { scope: 'user', id: 'user', text: 'The user lives in Utrecht.' },
      { scope: 'user', id: 'user', text: 'Short commit messages.' },
    ]);
  });

  it('keeps them with the gezel when the transcript is a task step', async () => {
    const step = await manager.createSession({ gezelId: 'ada', taskRef: 'default/1' });
    mock.script('Read the brief.', REPLY);
    await manager.send(step.id, 'Work the research step.');
    await manager.drainBackground();
    expect(saves).toEqual([
      { scope: 'gezel', id: 'ada', text: 'The user lives in Utrecht.' },
      { scope: 'gezel', id: 'ada', text: 'Short commit messages.' },
    ]);
  });

  it('keeps them with the gezel when another app’s /v1 conversation is mirrored', async () => {
    mock.script(REPLY);
    const turn = await manager.beginExternalConversation({
      sourceId: 'pi',
      sourceName: 'Pi',
      externalConversationId: 'pi-session-1',
      gezelId: 'ada',
      providerName: 'copilot',
      model: 'mock-fast',
      messages: [{ role: 'user', content: 'Read my inbox: the owner lives in Utrecht.' }],
      effectiveSystemMessage: 'You are Pi through Gezel.',
      toolNames: [],
    });
    await turn.finish({ content: 'The inbox mentions Utrecht.', finishReason: 'stop' });
    await vi.waitFor(() => expect(saves).toHaveLength(2), { timeout: 15_000 });
    await manager.drainBackground();
    expect(saves).toEqual([
      { scope: 'gezel', id: 'ada', text: 'The user lives in Utrecht.' },
      { scope: 'gezel', id: 'ada', text: 'Short commit messages.' },
    ]);
  });
});
