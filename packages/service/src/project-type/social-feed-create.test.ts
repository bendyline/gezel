import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Social Feed's first draft is a post the person can see on the board, made
 * with the type's own tools. A typed kickoff has no file tools, so a post
 * that could only be staged by hand in posts/_drafting/ was never made: one
 * Gemma 4 E4B lead wrote a plan over posts/index.json instead (2026-10-14).
 * Skips while the pinned Gilde predates `create_post` taking the post itself.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const atLeast = (version: string, floor: string): boolean => {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'social-feed-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('social feed', () => {
  it('creates a post from its title and body in one call', async (ctx) => {
    const detail = await catalog.get('project-type', 'social-feed');
    if (!detail || detail.manifest.kind !== 'project-type') return ctx.skip();
    if (!atLeast(detail.manifest.version, '1.0.2')) return ctx.skip();

    const project = await store.createProject({ name: 'Pottery posts' });
    await applyProjectType(
      { store, catalog, home },
      {
        projectId: project.id,
        typeId: 'social-feed',
        params: { brand: 'pottery studio' },
      },
    );
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
        scriptName: 'posts-store',
        inputs,
        trigger: { kind: 'manual', userInitiated: true },
      });
    try {
      const created = await run({
        action: 'create',
        title: 'Finding the rhythm in the clay',
        body: 'Every pot starts as a lump that will not sit still.',
        platforms: 'linkedin',
      });
      expect(created.error).toBeUndefined();
      const id = (created.output as { id: string }).id;
      expect(id).toMatch(/finding-the-rhythm-in-the-clay$/);

      const workspace = await store.projectWorkspaceDir(project.id);
      const index = JSON.parse(await readFile(join(workspace, 'posts', 'index.json'), 'utf8')) as {
        posts: Array<{ id: string; status: string; title?: string }>;
      };
      // The board files each post by its status; an entry without one shows nowhere.
      expect(index.posts).toEqual([
        expect.objectContaining({
          id,
          status: 'approved',
          title: 'Finding the rhythm in the clay',
        }),
      ]);
      const post = await readFile(join(workspace, 'posts', id, 'post.md'), 'utf8');
      expect(post).toContain('platforms: [linkedin]');
      expect(post).toContain('Every pot starts as a lump');
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);
});
