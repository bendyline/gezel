import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-notices-'));
  store = new Store({ home });
  await store.ensureLayout();
  // Without a pinned provider, routing falls through to the platform default
  // (an on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', new MockProvider({ name: 'copilot' })]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — crew introduction', () => {
  // A copywriter and an omroeper joined the roster mid-task with no word to
  // the owner.
  it('introduces a new hire in the thread the owner reads', async () => {
    const thread = await manager.createSession({ gezelId: 'ada' });
    const hire = await store.createGezel({ name: 'Kylian', role: 'Copywriter' });
    const task = {
      projectId: 'default',
      num: 8,
      ref: 'default/8',
      title: 'Bakery weekly admin',
      status: 'active',
      launchSessionId: thread.id,
    } as Task;
    const step = { id: 'draft', name: 'Draft posts and quotes' } as TaskCraftbookStep;

    await expect(manager.postCrewIntroduction(task, hire.id, step)).resolves.toBe(thread.id);
    const intro = (await store.getSession('ada', thread.id))?.messages.at(-1);
    expect(intro).toMatchObject({ role: 'assistant', synthetic: 'crew-introduction' });
    expect(intro?.content).toBe(
      'I\'ve brought **Kylian** onto the crew as your Copywriter for **Bakery weekly admin**. Kylian starts with "Draft posts and quotes".',
    );
    // The thread's own gezel needs no introduction.
    await expect(manager.postCrewIntroduction(task, 'ada', step)).resolves.toBeNull();
  });

  // The UX review: the composer addressed a voorman nobody had introduced,
  // and a typed project's lead arrived without a word.
  it('introduces whoever starts and the lead at kickoff, as cards, once per thread', async () => {
    const thread = await manager.createSession({ gezelId: 'ada' });
    const guide = await store.createGezel({ name: 'Mira', role: 'Reisleider' });
    const lead = await store.createGezel({ name: 'Anastasia', role: 'Voorman' });
    const task = {
      projectId: 'default',
      num: 9,
      ref: 'default/9',
      title: 'Trip: Portugal',
      status: 'active',
      launchSessionId: thread.id,
      assignee: { kind: 'gezel', gezelId: lead.id },
    } as Task;
    const step = { id: 'draft', name: 'First draft' } as TaskCraftbookStep;

    await manager.postCrewIntroduction(task, guide.id, step, 'kickoff');
    const intro = (await store.getSession('ada', thread.id))?.messages.at(-1);
    expect(intro?.crewIntroduction).toEqual({
      taskRef: 'default/9',
      moment: 'kickoff',
      members: [
        {
          gezelId: guide.id,
          name: 'Mira',
          role: 'Reisleider',
          gloss: 'trip planner',
          stepName: 'First draft',
        },
        { gezelId: lead.id, name: 'Anastasia', role: 'Voorman', gloss: 'crew lead' },
      ],
    });
    expect(intro?.content).toBe(
      'Your crew for **Trip: Portugal**: **Mira** (Reisleider — trip planner) starts with "First draft", and **Anastasia** (Voorman — crew lead) leads it.',
    );
    // Introduced once: a later step does not introduce Mira again.
    await expect(manager.postCrewIntroduction(task, guide.id, step, 'joined')).resolves.toBeNull();
    const timeline = await store.listTimeline({ limit: 50 });
    expect(timeline.messages.some((m) => m.crewIntroduction?.moment === 'kickoff')).toBe(true);
  });
});

describe('ChatManager — task wrap-up', () => {
  // A kickoff from the meester's Default thread builds in a project of its
  // own; its wrap-up opened the file against Default and credited no one.
  it('says which project holds the deliverable and who made it', async () => {
    const thread = await manager.createSession({ gezelId: 'ada' });
    const maker = await store.createGezel({ name: 'Mira', role: 'Planner' });
    const trip = await store.createProject({ name: 'Family trip' });
    await store.writeProjectWorkspaceFile(trip.id, 'family-trip.md', '# Ten days\n');
    const task = {
      projectId: trip.id,
      num: 1,
      ref: `${trip.id}/1`,
      title: 'Family trip',
      status: 'complete',
      launchSessionId: thread.id,
      assignee: { kind: 'gezel', gezelId: 'ada' },
      craftbook: {
        steps: [
          {
            id: 'build',
            name: 'Write it',
            advanceWhen: { file: 'family-trip.md' },
            assignee: { kind: 'gezel', gezelId: maker.id },
          },
        ],
      },
    } as unknown as Task;
    await manager.postTaskWrapUp(task, 'complete');
    const reply = (await store.getSession('ada', thread.id))?.messages.at(-1);
    expect(reply?.deliverable).toMatchObject({
      kind: 'workspace',
      path: 'family-trip.md',
      projectId: trip.id,
    });
    expect(reply?.deliverable?.view).toBeUndefined();
    expect(reply?.makerGezelId).toBe(maker.id);
    // File chips resolve against the thread's project, where this file is not.
    expect(reply?.referencedFiles).toBeUndefined();
  });

  // The owner used to learn a task was done from the worker's tool receipt
  // ("Active step is now "(none)". Task is now complete (terminal step).").
  it('tells the launching thread what the task made and raises task_settled', async () => {
    const thread = await manager.createSession({ gezelId: 'ada' });
    const worker = await manager.createSession({
      gezelId: 'ada',
      taskRef: 'default/7',
      parentSession: { sessionId: thread.id, gezelId: 'ada', kind: 'task-entry' },
    });
    const workerRecord = await store.getSession('ada', worker.id);
    const at = new Date().toISOString();
    const write = (name: string, path: string) => ({
      name,
      path,
      at,
      durationMs: 1,
      success: true,
    });
    workerRecord!.messages.push({
      role: 'assistant',
      content: '',
      at,
      toolCalls: [
        write('write_file', 'social/drafts/gone.md'),
        write('write_file', 'social/final/week.md'),
        write('write_artifact', 'tasks/7/quote.md'),
      ],
    });
    await store.writeSession(workerRecord!);
    await store.writeProjectWorkspaceFile('default', 'social/final/week.md', '# Week\n');
    await store.writeProjectArtifact('default', 'tasks/7/quote.md', '# Quote\n');
    await store.writeProjectArtifact('default', 'tasks/7/summary.md', '# Summary\n');
    await store.writeProjectArtifact('default', 'tasks/7/inputs/brief.md', '# Brief\n');

    const settled: unknown[] = [];
    const unsubscribe = events.subscribeProject('default', (env) => {
      if (env.event.type === 'task_settled') settled.push(env.event);
    });
    const task = {
      projectId: 'default',
      num: 7,
      ref: 'default/7',
      title: 'Weekly posts',
      status: 'complete',
      launchSessionId: worker.id,
      artifactDir: 'tasks/7',
    } as Task;
    const posted = await manager.postTaskWrapUp(task, 'complete');
    unsubscribe();

    // Launched from inside a task session, it climbs to the owner's thread.
    expect(posted).toBe(thread.id);
    const reply = (await store.getSession('ada', thread.id))?.messages.at(-1);
    expect(reply).toMatchObject({ role: 'assistant', synthetic: 'task-wrapup' });
    expect(reply?.content).toContain('**Weekly posts** is finished');
    expect(reply?.referencedFiles).toEqual([
      { kind: 'workspace', path: 'social/final/week.md' },
      { kind: 'artifact', path: 'tasks/7/quote.md' },
      { kind: 'artifact', path: 'tasks/7/summary.md' },
    ]);
    expect(reply?.referencedTasks).toEqual(['default/7']);
    expect(settled).toEqual([
      {
        type: 'task_settled',
        taskRef: 'default/7',
        title: 'Weekly posts',
        outcome: 'complete',
        sessionId: thread.id,
      },
    ]);

    // A "ready for you" card in Updates, pointing at the wrap-up.
    const cards = (await store.listProjectQuestions('default')).filter(
      (q) => q.intent?.kind === 'task-finished',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      sessionId: thread.id,
      taskRef: 'default/7',
      documentPath: 'tasks/7/quote.md',
      choices: ['Dismiss'],
    });
    expect(cards[0]!.prompt).toContain('**Weekly posts** is finished.');
    // Settling twice files no second card.
    await manager.postTaskWrapUp(task, 'complete');
    expect(
      (await store.listProjectQuestions('default')).filter(
        (q) => q.intent?.kind === 'task-finished',
      ),
    ).toHaveLength(1);

    await expect(
      manager.postTaskWrapUp({ ...task, parentTaskRef: 'default/6' }, 'complete'),
    ).resolves.toBeNull();
  });
});
