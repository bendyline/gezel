import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTypeTurnProblems, stateAnswerTool } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { applyProjectType } from './apply.js';
import { resolvePageTools, resolveProjectScriptTools } from './script-tools.js';

/**
 * Word Clues: the cast game. Two clue-givers take turns over a board the app
 * deals and scores; the model's whole job is one typed clue. Runs the shipped
 * engine through the sandbox. Skips while the pinned Gilde lacks the type.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

interface Cell {
  word: string;
  kind: 'target' | 'neutral' | 'trap';
  revealed: boolean;
}

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'word-clues-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('word clues', () => {
  it('deals a board, holds clues to the rules, and scores the player’s picks', async (ctx) => {
    const detail = await catalog.get('project-type', 'word-clues');
    if (!detail || detail.manifest.kind !== 'project-type') return ctx.skip();
    expect(projectTypeTurnProblems(detail.manifest)).toEqual([]);

    const project = await store.createProject({ name: 'Word Clues' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'word-clues' },
    );
    expect(applied.gezelsCreated.map((g) => g.voorman)).toEqual([true, false]);
    const roles = await Promise.all(
      applied.gezelsCreated.map(async (g) => (await store.getGezel(g.id))?.role),
    );
    expect(roles).toEqual(['Woordsmid', 'Puzzelaar']);
    // A template's character is the gezel's character.
    const woordsmid = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(woordsmid?.character).toMatchObject({ temperament: 'lively', quirk: 'storyteller' });

    const detailProject = await store.getProject(project.id);
    const tools = await resolveProjectScriptTools(catalog, detailProject);
    expect(tools.map((t) => t.name)).toEqual(['board', 'give_clue']);
    expect((await resolvePageTools(catalog, detailProject))?.tools.map((t) => t.name)).toEqual([
      'new_game',
      'guess',
      'pass',
      'ask_clue_a',
      'ask_clue_b',
    ]);

    const chat = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', new MockProvider({ name: 'copilot' })]],
      catalog,
      secrets: new FileSecretStore(home),
    });
    const runner = new ScriptRunner({ store, chat, catalog });
    const run = async (inputs: Record<string, unknown>) =>
      runner.run({
        projectId: project.id,
        scriptName: 'clue-store',
        inputs,
        trigger: { kind: 'manual', userInitiated: true },
      });
    const ok = async (inputs: Record<string, unknown>) => {
      const result = await run(inputs);
      expect(result.error).toBeUndefined();
      return result.output as Record<string, unknown>;
    };
    const board = async () =>
      (
        JSON.parse(
          await readFile(join(await store.projectWorkspaceDir(project.id), 'game.json'), 'utf8'),
        ) as { words: Cell[] }
      ).words;
    try {
      const dealt = await ok({ action: 'new_game' });
      expect(dealt).toMatchObject({ status: 'clue_needed', giver: 'a' });
      const words = await board();
      expect(words).toHaveLength(16);
      expect(words.filter((w) => w.kind === 'target')).toHaveLength(6);
      expect(words.filter((w) => w.kind === 'trap')).toHaveLength(1);
      expect(stateAnswerTool(tools, dealt)).toBe('give_clue');
      const targets = words.filter((w) => w.kind === 'target').map((w) => w.word);
      const neutral = words.find((w) => w.kind === 'neutral')!.word;
      const trap = words.find((w) => w.kind === 'trap')!.word;

      // Clues that break the rules come back with the reason, for a retry.
      expect((await run({ action: 'give_clue', clue: targets[0], count: 1 })).error).toMatch(
        /is on the board/,
      );
      expect((await run({ action: 'give_clue', clue: `${targets[0]}s`, count: 1 })).error).toMatch(
        /is a form of the board word/,
      );
      expect((await run({ action: 'give_clue', clue: 'two words', count: 1 })).error).toMatch(
        /one word/,
      );
      expect((await run({ action: 'give_clue', clue: 'zzqx', count: 9 })).error).toMatch(
        /from 1 to 6/,
      );

      const clue = await ok({ action: 'give_clue', clue: 'zzqx', count: 2, say: 'Go on!' });
      expect(clue).toMatchObject({ status: 'guessing', display: 'Clue: ZZQX, 2. Go on!' });
      expect(await ok({ action: 'guess', word: targets[0] })).toMatchObject({
        result: 'target',
        status: 'guessing',
      });
      // A bystander ends the turn and hands it to the other clue-giver.
      expect(await ok({ action: 'guess', word: neutral })).toMatchObject({
        result: 'neutral',
        status: 'clue_needed',
        giver: 'b',
      });

      await ok({ action: 'give_clue', clue: 'zzqy', count: 5 });
      for (const word of targets.slice(1)) await ok({ action: 'guess', word });
      expect(await ok({ action: 'board' })).toMatchObject({
        status: 'won',
        summary: expect.stringContaining('found all six'),
      });

      await ok({ action: 'new_game' });
      await ok({ action: 'give_clue', clue: 'zzqx', count: 1 });
      const nextTrap = (await board()).find((w) => w.kind === 'trap')!.word;
      expect(await ok({ action: 'guess', word: nextTrap })).toMatchObject({
        result: 'trap',
        status: 'lost',
      });
      expect(trap).toBeTruthy();
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);
});
