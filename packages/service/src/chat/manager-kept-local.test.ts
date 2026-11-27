import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeptLocalSource, ProviderName } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEPT_LOCAL_CODE, KeptLocalData } from '../connectors/kept-local.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type SearchService, scoreResult } from '../search/search-service.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A conversation that was shown data kept on this computer stays here: its
 * turns, its summaries, what it passes on, and what it answers.
 */

let home: string;
let store: Store;
let manager: ChatManager;
let local: MockProvider;
let cloud: MockProvider;
let projectId: string;
let source: KeptLocalSource;
let saves: Array<{ text: string; source?: { kept?: string } }>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-kept-chat-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'ollama' });
  await store.createGezel({ name: 'Leo', role: 'Secretary' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createGezel({ name: 'Cleo', role: 'Developer' });
  await runOn('cleo', 'copilot');
  projectId = (await store.createProject({ name: 'Week' })).id;
  await allowCloud(false);
  source = { projectId, bindingId: 'calendar-google:ab12', name: 'Work' };
  saves = [];
  const memory = {
    save: async (_s: string, _i: string, text: string, _k: string, src?: { kept?: string }) => {
      saves.push({ text, ...(src ? { source: src } : {}) });
      return { status: 'saved' as const };
    },
    search: async () => [],
    searchAll: async () => [],
    reindex: async () => 0,
    writeSummary: async () => {},
    getRecent: async () => '',
  } as unknown as MemoryManager;
  local = new MockProvider({ name: 'ollama' });
  cloud = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [
      ['ollama', local],
      ['copilot', cloud],
    ],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function runOn(gezelId: string, provider: ProviderName): Promise<void> {
  await store.updateGezelSettings(gezelId, { provider });
}

async function allowCloud(allow: boolean): Promise<void> {
  await store.updateProject(projectId, {
    connectors: [
      {
        id: 'calendar-google:ab12',
        type: 'calendar-google',
        displayName: 'Work',
        corpusDir: 'data/work',
        config: {},
        ...(allow ? { allowCloudModels: true } : {}),
      },
    ],
  });
}

async function markedSession(gezelId = 'leo'): Promise<string> {
  const session = await manager.createSession({ gezelId, projectId });
  await manager.markKeptLocal(session.id, [source]);
  return session.id;
}

async function say(sessionId: string, text = 'hello'): Promise<void> {
  local.script('from here', 'NONE');
  cloud.script('from the cloud', 'NONE');
  await manager.send(sessionId, text);
}

const sent = (provider: MockProvider) => provider.calls.filter((c) => c.kind === 'send').length;
const reply = async (sessionId: string) =>
  (await manager.getSessionRecord(sessionId))?.messages
    .filter((m) => m.role === 'assistant')
    .at(-1);

describe('a conversation that read kept data', () => {
  it('stays on the model here when its gezel moves to a cloud one', async () => {
    const id = await markedSession();
    await say(id);
    await runOn('leo', 'copilot');
    await manager.resetClient();
    await say(id, 'and tomorrow?');
    expect(sent(cloud)).toBe(0);
    expect((await manager.getSessionRecord(id))?.providerName).toBe('ollama');

    const fresh = await manager.createSession({ gezelId: 'leo', projectId });
    await say(fresh.id);
    expect(sent(cloud)).toBe(1);
  });

  it('follows its gezel once the person allows cloud models', async () => {
    const id = await markedSession();
    await say(id);
    await runOn('leo', 'copilot');
    await allowCloud(true);
    await manager.resetClient();
    await say(id, 'and tomorrow?');
    expect(sent(cloud)).toBe(1);
  });

  it('survives a restart of the marking', async () => {
    const id = await markedSession();
    expect((await store.findSessionById(id))?.keptLocal).toEqual([source]);
    expect(await manager.keptLocalSources(id)).toEqual([source]);
    await allowCloud(true);
    expect(await manager.keptLocalSources(id)).toEqual([]);
  });

  it('is never handed to a one-shot elsewhere', async () => {
    const id = await markedSession();
    cloud.script('summary');
    const ask = (ofSessionId?: string) =>
      manager.oneShotCompletion('Summarize this', 5_000, {
        providerName: 'copilot',
        ...(ofSessionId ? { ofSessionId } : {}),
      });
    await expect(ask(id)).rejects.toMatchObject({ code: KEPT_LOCAL_CODE });
    await expect(ask()).resolves.toBe('summary');
    local.script('summary here');
    await expect(
      manager.oneShotCompletion('Summarize this', 5_000, {
        providerName: 'ollama',
        ofSessionId: id,
      }),
    ).resolves.toBe('summary here');
  });

  it('keeps a script it ran from asking a cloud model', async () => {
    const id = await markedSession();
    await expect(
      manager.oneShotCompletion('Classify', 5_000, {
        providerName: 'copilot',
        onBehalfOfSessionId: id,
      }),
    ).rejects.toMatchObject({ code: KEPT_LOCAL_CODE });
  });

  it('tags what it remembers', async () => {
    const id = await markedSession();
    // An on-device model extracts every ten messages, once the chat is idle.
    local.script('one', 'two', 'three', 'four', 'five', 'PROJECT/FACT: The dentist is on Tuesday.');
    for (let i = 0; i < 5; i++) await manager.send(id, 'when is the dentist?');
    await manager.flushPendingMemoryExtractions();
    expect(saves).toEqual([
      {
        text: 'The dentist is on Tuesday.',
        source: expect.objectContaining({ kept: 'calendar-google.ab12' }),
      },
    ]);
  });
});

describe('what it passes on', () => {
  it('reaches a gezel here, whose conversation then stays here too', async () => {
    const id = await markedSession();
    local.script('noted', 'NONE');
    const sentTo = await manager.messageGezel({
      fromGezelId: 'leo',
      fromSessionId: id,
      toGezelIdOrName: 'ada',
      projectId,
      text: 'The dentist is on Tuesday.',
      suppressReply: true,
    });
    expect(await manager.keptLocalSources(sentTo.sessionId)).toEqual([source]);
  });

  it('never reaches a gezel on a cloud model', async () => {
    const id = await markedSession();
    const message = {
      fromGezelId: 'leo',
      toGezelIdOrName: 'cleo',
      projectId,
      text: 'The dentist is on Tuesday.',
      suppressReply: true,
    };
    await expect(manager.messageGezel({ ...message, fromSessionId: id })).rejects.toThrow(
      /Work, which stays on this computer/,
    );
    // The route knows who called even when the routing leaves the sender out.
    await expect(manager.messageGezel({ ...message, callerSessionId: id })).rejects.toThrow(
      /stays on this computer/,
    );
    const asked = await manager.askGezelAndWait({
      fromGezelId: 'leo',
      fromSessionId: id,
      toGezelIdOrName: 'cleo',
      text: 'What should I bring?',
    });
    expect(asked).toMatchObject({ outcome: 'error' });
    expect(sent(cloud)).toBe(0);
  });

  it('is not answered to a cloud gezel, which is told where the person can read it', async () => {
    const asker = await manager.createSession({ gezelId: 'cleo', projectId });
    local.script('The dentist is on Tuesday.', 'NONE');
    // The gezel reads the calendar while answering, as a tool call would.
    const onCreate = manager.createSession.bind(manager);
    manager.createSession = async (args) => {
      const session = await onCreate(args);
      if (args.gezelId === 'leo') await manager.markKeptLocal(session.id, [source]);
      return session;
    };
    const answer = await manager.askGezelAndWait({
      fromGezelId: 'cleo',
      fromSessionId: asker.id,
      toGezelIdOrName: 'leo',
      text: 'When is the dentist?',
    });
    expect(answer.outcome).toBe('reply');
    const text = answer.outcome === 'reply' ? answer.text : '';
    expect(text).not.toContain('Tuesday');
    expect(text).toContain("Leo's chat");
  });

  it('marks a gezel here that hears the answer', async () => {
    const asker = await manager.createSession({ gezelId: 'ada', projectId });
    local.script('The dentist is on Tuesday.', 'NONE');
    const onCreate = manager.createSession.bind(manager);
    manager.createSession = async (args) => {
      const session = await onCreate(args);
      if (args.gezelId === 'leo') await manager.markKeptLocal(session.id, [source]);
      return session;
    };
    const answer = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: asker.id,
      toGezelIdOrName: 'leo',
      text: 'When is the dentist?',
    });
    expect(answer).toMatchObject({ outcome: 'reply', text: 'The dentist is on Tuesday.' });
    expect(await manager.keptLocalSources(asker.id)).toEqual([source]);
  });

  it('stops a conversation opened from it on a cloud gezel', async () => {
    const id = await markedSession();
    const child = await manager.createSession({
      gezelId: 'cleo',
      projectId,
      parentSession: { sessionId: id, gezelId: 'leo', kind: 'delegation' },
    });
    await say(child.id).catch(() => {});
    expect(sent(cloud)).toBe(0);
    const record = await manager.getSessionRecord(child.id);
    expect(record?.lastTurnErrorDetail?.code).toBe(KEPT_LOCAL_CODE);
    expect(record?.lastTurnError).toContain('Let cloud AI read this');
  });
});

describe('a task that read kept data', () => {
  it('keeps its folder and its other steps here', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const task = await new TaskManager(store).create(projectId, {
      title: 'Plan the week',
      assignee: { kind: 'gezel', gezelId: 'leo' },
      steps: [{ name: 'Look' }, { name: 'Write' }],
    });
    const step = await manager.createSession({ gezelId: 'leo', projectId, taskRef: task.ref });
    await manager.markKeptLocal(step.id, [source]);
    expect(await manager.keptLocalTaskSources(projectId, task.num)).toContainEqual(source);
    const data = new KeptLocalData(store);
    expect(
      data.areaForPath(await data.areas(projectId), `tasks/${task.num}/week.md`)?.source,
    ).toEqual(source);

    const next = await manager.createSession({ gezelId: 'cleo', projectId, taskRef: task.ref });
    await say(next.id).catch(() => {});
    expect(sent(cloud)).toBe(0);
  });
});

describe('what a gezel is told and shown', () => {
  const setupOf = (provider: MockProvider) =>
    JSON.stringify(provider.calls.find((c) => c.kind === 'create')?.opts ?? {});

  it('names a kept connection to a cloud gezel, without its folder', async () => {
    const onCloud = await manager.createSession({ gezelId: 'cleo', projectId });
    await say(onCloud.id);
    expect(setupOf(cloud)).toContain('Let cloud AI read this');
    expect(setupOf(cloud)).not.toContain('data/work');

    const here = await manager.createSession({ gezelId: 'leo', projectId });
    await say(here.id);
    expect(setupOf(local)).toContain('data/work');
    expect(setupOf(local)).not.toContain('Let cloud AI read this');
  });

  it('rebuilds a cloud conversation when the person changes their mind', async () => {
    const id = (await manager.createSession({ gezelId: 'cleo', projectId })).id;
    await say(id);
    await allowCloud(true);
    await say(id, 'and now?');
    // One-shots open sessions of their own; only the conversation's name the connection.
    const setups = cloud.calls
      .filter((c) => c.kind === 'create' || c.kind === 'resume')
      .map((c) => JSON.stringify(c.opts))
      .filter((setup) => setup.includes('Connected data'));
    expect(setups).toHaveLength(2);
    expect(setups[0]).toContain('Let cloud AI read this');
    expect(setups[1]).toContain('data/work');
    expect(setups[1]).not.toContain('Let cloud AI read this');
  });

  it('puts kept records in no cloud turn, and marks a local turn that gets one', async () => {
    const hit = {
      kind: 'content' as const,
      id: 'content:work',
      title: 'dentist.md',
      snippet: 'Dentist appointment on Tuesday at nine.',
      projectId,
      path: 'data/work/dentist.md',
      retrievalSource: 'artifacts' as const,
      source: 'artifacts' as const,
      arm: 'fts' as const,
      ...scoreResult('content', 0.9),
    };
    await store.writeProjectArtifact(
      projectId,
      'data/work/dentist.md',
      'Dentist appointment on Tuesday at nine.',
    );
    manager.setSearchService({
      searchProject: async (
        _q: string,
        o: { omitArtifact?: (projectId: string, path: string) => boolean },
      ) => ({
        results: o.omitArtifact?.(hit.projectId, hit.path) ? [] : [hit],
        truncated: false,
      }),
    } as unknown as SearchService);

    const onCloud = await manager.createSession({ gezelId: 'cleo', projectId });
    await say(onCloud.id, 'when is the dentist appointment?');
    expect(cloud.calls.find((c) => c.kind === 'send')?.prompt).not.toContain('Tuesday at nine');

    const here = await manager.createSession({ gezelId: 'leo', projectId });
    await say(here.id, 'when is the dentist appointment?');
    expect(local.calls.find((c) => c.kind === 'send')?.prompt).toContain('Tuesday at nine');
    expect(await manager.keptLocalSources(here.id)).toEqual([source]);
    expect(await reply(here.id)).toBeDefined();
  });
});
