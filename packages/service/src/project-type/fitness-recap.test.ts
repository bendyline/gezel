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
 * The fitness coach's logging and weekly recap (1.1.0+): sessions logged from
 * the page flag a personal best, the script computes the week against the
 * last, and the coach's save_recap adds one suggestion to a recap file the
 * embedded craftbook gates as valid JSON. Skips while the pinned Gilde
 * predates the recap.
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
  home = await mkdtemp(join(tmpdir(), 'fitness-recap-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('fitness coach recap', () => {
  it('logs sessions, computes the week, and saves a recap with one suggestion', async (ctx) => {
    const detail = await catalog.get('project-type', 'fitness-coach');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    const request = detail.manifest.tools.find((tool) => tool.name === 'request_recap');
    if (!request) return ctx.skip();
    expect(projectTypeTurnProblems(detail.manifest)).toEqual([]);

    const project = await store.createProject({ name: 'Training' });
    const applied = await applyProjectType(
      { store, catalog, home },
      {
        projectId: project.id,
        typeId: 'fitness-coach',
        params: { goal: 'a 10K', weeklyTarget: 3 },
      },
    );
    expect(applied.craftbooksInstalled).toEqual(['training-recap']);
    expect(
      (await resolvePageTools(catalog, await store.getProject(project.id)))?.tools.map(
        (t) => t.name,
      ),
    ).toEqual(['page_log_workout', 'request_recap']);

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
    const run = async (inputs: Record<string, unknown>) => {
      const result = await runner.run({
        projectId: project.id,
        scriptName: 'training-store',
        inputs,
        trigger: { kind: 'manual', userInitiated: true },
      });
      expect(result.error).toBeUndefined();
      return result.output as Record<string, unknown>;
    };
    try {
      expect(await run({ action: 'log_workout', activity: 'Run', minutes: 30 })).toMatchObject({
        personalBest: false,
      });
      expect(await run({ action: 'log_workout', activity: 'Run', minutes: 45 })).toMatchObject({
        personalBest: true,
      });
      const numbers = await run({ action: 'request_recap' });
      expect(numbers).toMatchObject({
        status: 'recap_wanted',
        recap: { sessions: 2, target: 3, minutes: 75, longest: { activity: 'Run', minutes: 45 } },
      });
      expect(reactionRequiredTool(request.reaction, numbers, detail.manifest.tools)).toBe(
        'save_recap',
      );

      const saved = await run({
        action: 'save_recap',
        suggestion: 'Add one easy 20-minute run midweek to reach three sessions.',
      });
      expect(String(saved.display)).toMatch(
        /^Week of \d{4}-\d{2}-\d{2}: 2 of 3 session\(s\), 75 min \(\+75 min vs last week\)\. Next week: Add one easy/,
      );
      const latest = JSON.parse(
        await readFile(
          join(await store.projectWorkspaceDir(project.id), 'recaps', 'latest.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(latest).toMatchObject({
        sessions: 2,
        minutes: 75,
        suggestion: 'Add one easy 20-minute run midweek to reach three sessions.',
      });
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);
});
