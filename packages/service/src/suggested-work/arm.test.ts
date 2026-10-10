import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOLDER_KIND_PROPERTY,
  NIGHT_WORK_ARMED_AT_PROPERTY,
  NIGHT_WORK_PROPERTY,
  type SuggestedWorkItem,
  projectNightWorkEnabled,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { armResidentNightWork, armableNightBooks, setFolderNightWork } from './arm.js';

const resolveMock = vi.hoisted(() => ({ items: [] as SuggestedWorkItem[] }));
const enableMock = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('./resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve.js')>()),
  resolveSuggestedWork: async () => resolveMock.items,
}));
vi.mock('./enable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./enable.js')>()),
  enableSuggestedWork: async (_deps: unknown, args: { key: string }) => {
    enableMock.calls.push(args.key);
    const item = resolveMock.items.find((i) => i.key === args.key)!;
    return { item: { ...item, state: 'enabled' }, task: {} };
  },
}));

let home: string;
let store: Store;
let tasks: TaskManager;
let projectId: string;

function item(craftbookId: string, gezelId = 'g1', over: Partial<SuggestedWorkItem> = {}) {
  return {
    key: `gezel-template:t:${craftbookId}`,
    source: { kind: 'gezel-template', templateId: 't', gezelId },
    craftbookId,
    runMode: 'night-shift',
    state: 'available',
    ...over,
  } as SuggestedWorkItem;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-arm-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  tasks = new TaskManager(store, history);
  projectId = (await store.createProject({ name: 'App', workingDir: join(home, 'app') })).id;
  await store.updateProject(projectId, { properties: { [FOLDER_KIND_PROPERTY]: 'code' } });
  resolveMock.items = [];
  enableMock.calls = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const deps = (provider = 'llama-cpp') => ({
  store,
  tasks,
  catalog: new CatalogService(undefined, { localRoot: home }),
  providerForGezel: async () => provider as never,
});

describe('armResidentNightWork', () => {
  it('arms report-only night books that fit the folder, on a local model', async () => {
    resolveMock.items = [
      item('dependency-audit'),
      item('bug-fix-tdd'),
      item('nightly-fix-sweep'),
      item('photo-library-nightly'),
    ];

    const result = await armResidentNightWork(deps(), projectId);

    expect(enableMock.calls).toEqual(['gezel-template:t:dependency-audit']);
    expect(result.armed.map((i) => i.craftbookId)).toEqual(['dependency-audit']);
    const project = await store.getProject(projectId);
    expect(project?.properties?.[NIGHT_WORK_ARMED_AT_PROPERTY]).toBeTruthy();
  });

  it('leaves work on a cloud model for the person to approve', async () => {
    resolveMock.items = [item('dependency-audit')];
    const result = await armResidentNightWork(deps('anthropic'), projectId);
    expect(enableMock.calls).toEqual([]);
    expect(result.needsOk.map((i) => i.craftbookId)).toEqual(['dependency-audit']);
  });

  it('arms once, and never over a switched-off folder or a host the person paused', async () => {
    resolveMock.items = [item('dependency-audit', 'g1', { taskRef: 'app/1', state: 'paused' })];
    await armResidentNightWork(deps(), projectId);
    expect(enableMock.calls).toEqual([]);
    expect((await armResidentNightWork(deps(), projectId)).skipped).toBe('already-armed');

    const other = (await store.createProject({ name: 'B', workingDir: join(home, 'b') })).id;
    await store.updateProject(other, {
      properties: { [FOLDER_KIND_PROPERTY]: 'code', [NIGHT_WORK_PROPERTY]: 'off' },
    });
    expect((await armResidentNightWork(deps(), other)).skipped).toBe('switched-off');
  });

  it('keeps proposals and edits out of every kind', () => {
    for (const kind of ['code', 'pictures', 'documents', 'mixed'] as const) {
      expect(armableNightBooks(kind).has('bug-fix-tdd')).toBe(false);
      expect(armableNightBooks(kind).has('nightly-fix-sweep')).toBe(false);
    }
  });
});

describe('setFolderNightWork', () => {
  it('pauses the folder night hosts and resumes only those it paused', async () => {
    const make = (title: string) =>
      tasks.create(projectId, {
        title,
        description: 'A night host for the switch test.',
        assignee: { kind: 'user' },
        steps: [{ name: 'Wait for tonight' }],
        spawnsSteps: [{ name: 'Run' }],
        nightShift: { enabled: true },
        createdBy: { kind: 'user' },
      } as never);
    const a = await make('Audit');
    const b = await make('Review');
    await tasks.setStatus(projectId, b.num, 'paused');

    await setFolderNightWork({ store, tasks }, projectId, false);
    expect((await store.getProject(projectId))?.properties?.[NIGHT_WORK_PROPERTY]).toBe('off');
    expect((await tasks.get(projectId, a.num))?.status).toBe('paused');

    await setFolderNightWork({ store, tasks }, projectId, true);
    expect((await store.getProject(projectId))?.properties?.[NIGHT_WORK_PROPERTY]).toBe('on');
    expect((await tasks.get(projectId, a.num))?.status).toBe('active');
    expect((await tasks.get(projectId, b.num))?.status).toBe('paused');
  });

  it('persists an explicit opt-in for Default and can turn it off again', async () => {
    await store.ensureDefaultProject();
    expect(projectNightWorkEnabled((await store.getProject('default'))!)).toBe(false);

    await setFolderNightWork({ store, tasks }, 'default', true);
    expect(projectNightWorkEnabled((await store.getProject('default'))!)).toBe(true);

    await setFolderNightWork({ store, tasks }, 'default', false);
    expect(projectNightWorkEnabled((await store.getProject('default'))!)).toBe(false);
  });
});
