import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedSearchResult } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
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
