import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTypeTurnProblems, stateAnswerTool } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { applyProjectType } from './apply.js';
import { resolveProjectScriptTools } from './script-tools.js';

/**
 * The language trainer's role-play scenes (1.1.0+): a scene starts, the
 * tutor's `reply` records the mistakes it found, each becomes a review card
 * and a correction the tutor remembers, and the deck sets the reminder. Runs
 * the shipped script through the sandbox. Skips while the pinned Gilde
 * predates scenes.
 */

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lang-scenes-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('language trainer scenes', () => {
  it('grades a scene into corrections, review cards, memories and a reminder', async (ctx) => {
    const detail = await catalog.get('project-type', 'language-trainer');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    if (!detail.manifest.tools.some((tool) => tool.name === 'reply')) return ctx.skip();
    expect(projectTypeTurnProblems(detail.manifest)).toEqual([]);

    const project = await store.createProject({ name: 'Spanish' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Spanish' } },
    );
    const tutor = applied.gezelsCreated[0]!.id;
    const tools = await resolveProjectScriptTools(catalog, await store.getProject(project.id));
    expect(tools.map((t) => t.name)).toEqual([
      'practice_state',
      'reply',
      'begin_scene',
      'advance_level',
    ]);

    const save = vi.fn(async () => ({ status: 'saved' }));
    const memory = {
      search: async () => [],
      searchAll: async () => [],
      reindex: async () => 0,
      writeSummary: async () => {},
      getRecent: async () => '',
      save,
    } as unknown as MemoryManager;
    const chat = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', new MockProvider({ name: 'copilot' })]],
      catalog,
      secrets: new FileSecretStore(home),
    });
    const runner = new ScriptRunner({ store, chat, catalog, memory });
    const session = await chat.createSession({ gezelId: tutor, projectId: project.id });
    const run = async (inputs: Record<string, unknown>) => {
      const result = await runner.run({
        projectId: project.id,
        scriptName: 'progress-store',
        inputs,
        trigger: { kind: 'chat', sessionId: session.id, gezelId: tutor },
      });
      expect(result.error).toBeUndefined();
      return result.output as Record<string, unknown>;
    };
    try {
      const started = await run({ action: 'begin', scenario: 'coffee' });
      expect(started).toMatchObject({
        status: 'started',
        opening: true,
        scene: { title: 'Ordering at a café', youPlay: 'barista' },
      });

      const answered = await run({
        action: 'reply',
        say: '¡Claro! Un café con leche. ¿Algo más?',
        errors: [
          { wrong: 'una café', right: 'un café', note: 'café is masculine' },
          { wrong: 'una café', right: 'un café' },
          { wrong: 'same', right: 'same' },
        ],
      });
      expect(answered.display).toBe(
        '¡Claro! Un café con leche. ¿Algo más? — Corrections: "una café" → "un café" (café is masculine).',
      );
      expect(save).toHaveBeenCalledWith(
        'gezel',
        tutor,
        'Said "una café"; it is "un café" (café is masculine)',
        'correction',
        expect.anything(),
      );
      const deck = JSON.parse(
        await readFile(join(await store.projectWorkspaceDir(project.id), 'reviews.json'), 'utf8'),
      ) as { items: Array<{ id: string; box: number }> };
      expect(deck.items).toMatchObject([{ id: 'r-1', wrong: 'una café', box: 1 }]);
      const reminder = await store.getProjectReminder(project.id);
      expect(reminder).toMatchObject({ title: 'Spanish review', source: 'progress-store' });
      expect(Date.parse(reminder!.at) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

      // While a scene is in play, a person's message is answered through reply.
      const state = await run({ action: 'state' });
      expect(state).toMatchObject({ status: 'active', streak: 1, dueCount: 0 });
      expect(stateAnswerTool(tools, state)).toBe('reply');

      // Done is ignored until the student has played two lines.
      const early = await run({ action: 'reply', say: '¿Algo para comer?', done: true });
      expect(early).toMatchObject({ status: 'active', display: '¿Algo para comer?' });
      const finished = await run({
        action: 'reply',
        say: 'Son tres euros. ¡Que aproveche!',
        done: true,
      });
      expect(finished).toMatchObject({
        status: 'done',
        display: 'Son tres euros. ¡Que aproveche! Scene complete.',
      });
      const idle = await run({ action: 'state' });
      expect(idle.status).toBe('idle');
      expect(stateAnswerTool(tools, idle)).toBeUndefined();
      const progress = JSON.parse(
        await readFile(join(await store.projectWorkspaceDir(project.id), 'progress.json'), 'utf8'),
      ) as { sessions: number; history: unknown[] };
      expect(progress.sessions).toBe(1);
      expect(progress.history).toHaveLength(1);
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);
});
