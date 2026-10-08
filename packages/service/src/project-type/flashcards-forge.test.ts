import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTypeTurnProblems, reactionRequiredTool } from '@bendyline/gezel';
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
import { resolvePageTools } from './script-tools.js';

/**
 * The flashcards quiz forge (1.2.0+): notes pasted on the review page are
 * staged for the Studiemaat, whose required add_cards call saves at most eight
 * cards and replies with the deck's own summary. Skips while the pinned Gilde
 * predates the forge.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'flashcards-forge-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('flashcards quiz forge', () => {
  it('stages pasted notes and saves at most eight cards from them', async (ctx) => {
    const detail = await catalog.get('project-type', 'flashcards');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    const forge = detail.manifest.tools.find((tool) => tool.name === 'forge_from_notes');
    if (!forge) return ctx.skip();
    expect(projectTypeTurnProblems(detail.manifest)).toEqual([]);

    const project = await store.createProject({ name: 'Biology' });
    await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'flashcards', params: { subject: 'Biology' } },
    );
    expect(
      (await resolvePageTools(catalog, await store.getProject(project.id)))?.tools.map(
        (t) => t.name,
      ),
    ).toContain('forge_from_notes');

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
    const run = (inputs: Record<string, unknown>) =>
      runner.run({
        projectId: project.id,
        scriptName: 'deck-store',
        inputs,
        trigger: { kind: 'manual', userInitiated: true },
      });
    try {
      expect((await run({ action: 'stage_notes', notes: 'too short' })).error).toMatch(
        /a few sentences/,
      );
      const notes =
        'Mitochondria make ATP. Ribosomes build proteins. The nucleus holds DNA. ' +
        'Chloroplasts capture light.';
      const staged = await run({ action: 'stage_notes', notes });
      expect(staged.output).toMatchObject({ status: 'forging', notes });
      // The reaction requires the Studiemaat's one add_cards call.
      expect(reactionRequiredTool(forge.reaction, staged.output, detail.manifest.tools)).toBe(
        'add_cards',
      );

      const cards = Array.from({ length: 10 }, (_, i) => ({
        front: `Question ${i + 1}?`,
        back: `Answer ${i + 1}.`,
      }));
      const added = await run({ action: 'add_cards', cards });
      expect(added.output).toMatchObject({
        status: 'idle',
        total: 8,
        summary: 'Added 8 card(s). 8 in the deck, 8 due now.',
      });
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);
});
