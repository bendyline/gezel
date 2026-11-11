import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { type CreateProjectDeps, createProjectWithLead } from './create-project.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-create-project-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  catalog = new CatalogService(undefined, { localRoot: home });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Deps whose default model works best in `preferred`. */
function deps(preferred: 'crew' | 'solo') {
  const newProjectMode = vi.fn(async () => preferred);
  const value = {
    store,
    catalog,
    home,
    chat: { newProjectMode } as unknown as ChatManager,
    chatEvents: { publishGlobalEvent: vi.fn(), publishProjectEvent: vi.fn() },
  } as unknown as CreateProjectDeps;
  return { value, newProjectMode };
}

const mainGezel = async (projectId: string) => {
  const project = await store.getProject(projectId);
  return project?.voormanGezelId ? store.getGezel(project.voormanGezelId) : null;
};

describe('createProjectWithLead: the shape nobody chose', () => {
  // The app's New project sends autoMode; the shape comes from the default
  // model's preferred strategy (owner decision, 2026-11-10).
  it('makes a solo project with a Builder when the default model works best alone', async () => {
    const { value } = deps('solo');
    const project = await createProjectWithLead(value, { name: 'Spring menu', autoMode: true });

    expect(project.mode).toBe('solo');
    expect((await mainGezel(project.id))?.templateId).toBe('builder');

    // One Builder runs the next project too.
    const next = await createProjectWithLead(value, { name: 'Summer menu', autoMode: true });
    expect(next.voormanGezelId).toBe(project.voormanGezelId);
    expect(await store.listGezels()).toHaveLength(1);
  });

  it('makes a crew project with a crew lead when the default model works best stepwise', async () => {
    const { value } = deps('crew');
    const project = await createProjectWithLead(value, { name: 'Launch', autoMode: true });

    expect(project.mode ?? 'crew').toBe('crew');
    expect((await mainGezel(project.id))?.templateId).toBe('voorman');
  });

  it('keeps a crew for callers that do not ask, and honors a shape that was named', async () => {
    const { value, newProjectMode } = deps('solo');
    const plain = await createProjectWithLead(value, { name: 'Plain' });
    expect(plain.mode ?? 'crew').toBe('crew');
    expect((await mainGezel(plain.id))?.templateId).toBe('voorman');

    const named = await createProjectWithLead(value, {
      name: 'Named',
      mode: 'crew',
      autoMode: true,
    });
    expect(named.mode ?? 'crew').toBe('crew');
    expect(newProjectMode).not.toHaveBeenCalled();
  });
});
