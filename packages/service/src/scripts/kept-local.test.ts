import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeptLocalSource, ScriptCapability } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeptLocalData } from '../connectors/kept-local.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { type DispatcherContext, buildDispatcher } from './dispatcher.js';
import { ScriptKeptLocal } from './kept-local.js';

// A script's output goes to whoever started it, so a script must not be the
// way a cloud model reads what it was refused.

const EVENT = 'data/work/dentist.md';
let home: string;
let store: Store;
let projectId: string;
let marked: KeptLocalSource[];
let dispatch: ReturnType<typeof buildDispatcher>['dispatch'];
let save: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-script-kept-'));
  store = new Store({ home });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'Week' })).id;
  await store.createGezel({ name: 'Leo' });
  await store.createGezel({ name: 'Cleo' });
  await store.updateProject(projectId, {
    connectors: [
      {
        id: 'calendar-google:ab12',
        type: 'calendar-google',
        displayName: 'Work',
        corpusDir: 'data/work',
        config: {},
      },
    ],
  });
  const root = store.projectArtifactsDir(projectId);
  await mkdir(join(root, 'data/work'), { recursive: true });
  await writeFile(join(root, EVENT), 'Dentist on Tuesday');
  await writeFile(join(root, 'notes.md'), 'notes');
  marked = [];
  save = vi.fn(async () => ({ status: 'saved' }));
  dispatch = buildDispatcher({
    store,
    memory: {
      search: async () => [
        { text: 'Dentist on Tuesday', source: { kept: 'calendar-google.ab12' } },
        { text: 'Likes tea' },
      ],
      save,
    } as unknown as MemoryManager,
    keptLocal: new ScriptKeptLocal(store, {
      sessionRunsOnThisComputer: async (id) => id === 'here',
      gezelRunsOnThisComputer: async (id) => id === 'leo',
      markKeptLocal: async (_id, sources) => {
        marked.push(...sources);
      },
      markKeptLocalTags: async () => {},
      keptLocalSources: async () => marked,
    }),
  }).dispatch;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(who: Partial<DispatcherContext>): DispatcherContext {
  return {
    projectId,
    runId: 'r',
    scriptName: 's',
    allowedCapabilities: new Set<ScriptCapability>([
      'artifacts.read',
      'artifacts.write',
      'memory.read',
      'memory.write',
    ]),
    knownSecretValues: new Set(),
    ...who,
  };
}
const HERE = { initiatedByGezel: true, gezelId: 'leo', sessionId: 'here' };
const CLOUD = { initiatedByGezel: true, gezelId: 'cleo', sessionId: 'cloud' };
const PERSON = {};

const read = (who: Partial<DispatcherContext>) =>
  dispatch(run(who), 'artifact.read', { path: EVENT });
const list = async (who: Partial<DispatcherContext>) =>
  ((await dispatch(run(who), 'artifact.list', { recursive: true })) as { path: string }[]).map(
    (e) => e.path,
  );

describe('a script reading kept data', () => {
  it('reads it for the person and for a gezel here, whose conversation stays', async () => {
    expect(await read(PERSON)).toBe('Dentist on Tuesday');
    expect(marked).toEqual([]);
    expect(await read(HERE)).toBe('Dentist on Tuesday');
    expect(marked.map((s) => s.name)).toEqual(['Work']);
  });

  it('is refused it for a cloud gezel, and lists without it', async () => {
    await expect(read(CLOUD)).rejects.toThrow(/stays on this computer/);
    expect(await list(CLOUD)).not.toContain(EVENT);
    expect(await list(CLOUD)).toContain('notes.md');
    expect(await list(HERE)).toContain(EVENT);
  });

  it('follows the gezel a task step belongs to, and keeps the task here', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const tasks = new TaskManager(store);
    const make = (gezelId: string) =>
      tasks.create(projectId, {
        title: 'Plan the week',
        assignee: { kind: 'gezel', gezelId },
        steps: [{ name: 'Look' }],
      });
    const mine = await make('leo');
    const theirs = await make('cleo');
    const as = (task: typeof mine) => ({
      initiatedByGezel: true,
      step: { taskRef: task.ref, stepId: task.craftbook.steps[0]!.id },
    });
    await expect(read(as(theirs))).rejects.toThrow(/stays on this computer/);
    expect(await read(as(mine))).toBe('Dentist on Tuesday');
    const data = new KeptLocalData(store);
    expect(data.areaForPath(await data.areas(projectId), `tasks/${mine.num}/x.md`)).toBeDefined();
  });

  it('takes the cautious answer when it cannot tell whose run it is', async () => {
    await expect(read({ initiatedByGezel: true })).rejects.toThrow(/stays on this computer/);
  });

  it('remembers what a conversation that read it writes, and tags what it saves', async () => {
    await read(HERE);
    await dispatch(run(HERE), 'artifact.write', { path: 'reports/week.md', content: 'x' });
    const data = new KeptLocalData(store);
    expect(data.areaForPath(await data.areas(projectId), 'reports/week.md')).toBeDefined();
    await dispatch(run(HERE), 'memory.save', { text: 'Dentist on Tuesday' });
    expect(save.mock.calls[0]?.at(-1)).toMatchObject({ kept: 'calendar-google.ab12' });
  });

  it('recalls kept memories only for a model here', async () => {
    const recall = async (who: Partial<DispatcherContext>) =>
      ((await dispatch(run(who), 'memory.search', { query: 'dentist' })) as { text: string }[]).map(
        (r) => r.text,
      );
    expect(await recall(CLOUD)).toEqual(['Likes tea']);
    expect(await recall(HERE)).toEqual(['Dentist on Tuesday', 'Likes tea']);
  });
});
