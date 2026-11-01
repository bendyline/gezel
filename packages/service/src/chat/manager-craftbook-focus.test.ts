import { mkdtemp, rm } from 'node:fs/promises';
/**
 * ChatManager + a thread pinned to a craftbook (the editor's AI assist). The
 * thread is about improving that one book: it gets the book's section and
 * the editing kit, every message opens with the book as it stands and its
 * checkup, and nothing reads the message as work to route or start.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRAFTBOOK_FOCUS_BUILTIN_TOOLS, type Craftbook } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const BOOK: Craftbook = {
  id: 'weekly-review',
  name: 'Weekly review',
  description: 'Reviews the week and writes a short summary.',
  triggers: ['weekly review'],
  entryStepId: 'gather',
  steps: [
    {
      id: 'gather',
      name: 'Gather',
      suggestedRole: 'researcher',
      prompt: 'Collect what happened this week and write notes.md.',
      advanceWhen: { file: 'tasks/1/notes.md' },
    },
    { id: 'summarize', name: 'Summarize' },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

let svc: RunningService;
let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let crewLeadId: string;

/** The thread's own turns; the memory one-shot after each turn is a send too. */
function threadPrompts(): string[] {
  return mock.calls
    .filter((c) => c.kind === 'send')
    .map((c) => c.prompt ?? '')
    .filter((prompt) => prompt.startsWith('[The craftbook '));
}

beforeEach(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-craftbook-focus-test-'));
  svc = await startService({ home });
  store = svc.context.store;
  mock = new MockProvider({ name: 'openai' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => svc.port,
    getToken: () => svc.context.token,
    getCert: () => svc.cert?.certPem ?? null,
    home,
    providers: [['openai', mock]],
    catalog: svc.context.catalog,
    secrets: svc.context.secrets,
    history: svc.context.history,
  });
  // The service seeds a Meester with a random name, so use the id returned.
  crewLeadId = (await store.createGezel({ name: 'Malika', role: 'Crew Lead' })).id;
  await store.writeConfig({ provider: 'openai', toolFilterMode: 'always' });
  await store.writeLocalCraftbookTemplate(BOOK);
}, 20_000);

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

describe('ChatManager + a craftbook-editing thread', () => {
  it('briefs the thread about its book and opens each message with the book and its checkup', async () => {
    const thread = await manager.createSession({ gezelId: crewLeadId, craftbookRef: BOOK.id });
    mock.script('Added a check.');
    await manager.send(thread.id, 'Add a step that writes a PowerPoint deck of the findings.');

    const created = mock.calls.find((c) => c.kind === 'create');
    const system = created?.opts?.systemMessage ?? '';
    expect(system).toContain('## The craftbook open beside this chat');
    expect(system).toContain('the craftbook "Weekly review" (`weekly-review`)');
    expect(system).not.toContain('### Where work belongs');
    // A crew lead is a coordinator, so it keeps the role catalog too.
    expect([...(created?.opts?.toolAllowlist ?? [])].sort()).toEqual(
      [...CRAFTBOOK_FOCUS_BUILTIN_TOOLS].sort(),
    );

    const prompt = threadPrompts()[0] ?? '';
    expect(
      prompt.startsWith('[The craftbook "Weekly review" (`weekly-review`) as it stands now.'),
    ).toBe(true);
    expect(prompt).toContain('1. Gather (`gather`, entry): researcher; writes tasks/1/notes.md');
    expect(prompt).toContain('Step "Summarize" has no role');
    // The person's words close the turn, with no route or work-options prelude.
    expect(prompt.endsWith(']\n\nAdd a step that writes a PowerPoint deck of the findings.')).toBe(
      true,
    );
  }, 30_000);

  it('reads the book fresh on every turn, so a hand edit is never stale', async () => {
    const thread = await manager.createSession({ gezelId: crewLeadId, craftbookRef: BOOK.id });
    mock.script('Looks good.');
    await manager.send(thread.id, 'What would make this better?');
    await store.writeLocalCraftbookTemplate({
      ...BOOK,
      steps: [
        BOOK.steps[0]!,
        {
          id: 'summarize',
          name: 'Write the summary',
          suggestedRole: 'writer',
          prompt: 'Read notes.md and write summary.md.',
          advanceWhen: { file: 'tasks/1/summary.md' },
        },
      ],
    });
    mock.script('Nothing left to flag.');
    await manager.send(thread.id, 'And now?');

    const second = threadPrompts()[1] ?? '';
    expect(second).toContain(
      '2. Write the summary (`summarize`): writer; writes tasks/1/summary.md',
    );
    expect(second).toContain('Checkup: nothing to flag.');
  }, 30_000);

  it("never resumes a craftbook thread as the gezel's ordinary conversation", async () => {
    const thread = await manager.createSession({ gezelId: crewLeadId, craftbookRef: BOOK.id });
    mock.script('Noted.');
    await manager.send(thread.id, 'Tighten the first step.');

    const lobby = await manager.ensureOrCreateSession({
      gezelId: crewLeadId,
      projectId: 'default',
    });
    expect(lobby.id).not.toBe(thread.id);
    expect(lobby.craftbookRef).toBeUndefined();
  }, 30_000);
});
