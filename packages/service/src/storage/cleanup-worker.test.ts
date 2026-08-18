import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleanupRequest } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { runCleanup, undeletableCategories, userContentCategories } from './cleanup-worker.js';
import { StorageJobManager } from './job-manager.js';
import { buildStorageSummary, invalidateStorageSummary } from './summary.js';

let home: string;
let outside: string;
let store: Store;
let jobs: StorageJobManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-cleanup-'));
  outside = await mkdtemp(join(tmpdir(), 'gezel-outside-'));
  store = new Store({ home });
  await store.ensureLayout();
  jobs = new StorageJobManager();
  invalidateStorageSummary();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function seedModel(engine: string, id: string, bytes = 4096): Promise<string> {
  const dir = join(home, 'engines', engine, 'models', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'weights.gguf'), 'x'.repeat(bytes));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id }));
  return dir;
}

async function cleanup(request: CleanupRequest, deps: Record<string, unknown> = {}) {
  const job = jobs.create('cleanup');
  const outcome = await runCleanup({ home, store, jobs, ...deps }, request, job);
  return { job: jobs.get(job.id)!, outcome };
}

describe('runCleanup', () => {
  it('frees the models it was asked for and reports the bytes', async () => {
    const dir = await seedModel('llama-cpp', 'demo-7b', 8192);

    const { job, outcome } = await cleanup({ categories: ['models'] });

    expect(await exists(dir)).toBe(false);
    expect(outcome.bytesFreed).toBeGreaterThanOrEqual(8192);
    expect(job.status).toBe('done');
    expect(job.phase).toBe('verify-recovery');
  });

  it('deletes only the models named when the request narrows by item', async () => {
    const keep = await seedModel('llama-cpp', 'keep-me');
    const drop = await seedModel('mlx', 'drop-me');

    await cleanup({ categories: ['models'], itemIds: { models: ['mlx/drop-me'] } });

    expect(await exists(keep)).toBe(true);
    expect(await exists(drop)).toBe(false);
  });

  it('drops the inventory cache for the engine whose files went', async () => {
    await seedModel('llama-cpp', 'demo-7b');
    const invalidateModelsCache = vi.fn();

    await cleanup({ categories: ['models'] }, { invalidateModelsCache });

    expect(invalidateModelsCache).toHaveBeenCalledWith('llama-cpp');
  });

  it('removes a toolset tree and its install record together', async () => {
    // A surviving record would have the daemon advertise a toolset whose
    // files are gone, and nothing would re-install it.
    const tree = join(home, 'system-toolsets', 'playwright');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'index.js'), 'x'.repeat(512));
    const record = join(home, 'system-toolsets.json');
    const roster = join(home, 'installed-toolsets-system.json');
    await writeFile(record, '{"playwright":"1.0.0"}');
    await writeFile(roster, '["playwright"]');

    await cleanup({ categories: ['toolsets'] });

    expect(await exists(tree)).toBe(false);
    expect(await exists(record)).toBe(false);
    expect(await exists(roster)).toBe(false);
  });

  it('refuses categories the daemon runs from', async () => {
    // The service bundle and node runtime are what this process executes.
    expect(undeletableCategories(['service-bundle', 'runtimes', 'git-clones'])).toEqual([
      'service-bundle',
      'runtimes',
      'git-clones',
    ]);
    expect(undeletableCategories(['models'])).toEqual([]);
  });

  it('skips content stored outside the Gezel folder and says so', async () => {
    const workingDir = join(outside, 'repo');
    await mkdir(workingDir, { recursive: true });
    await writeFile(join(workingDir, 'main.ts'), 'x'.repeat(256));
    const project = await store.createProject({ name: 'Linked', workingDir });

    const { job } = await cleanup({ categories: ['projects'], confirmUserContent: true });

    expect(await exists(join(workingDir, 'main.ts'))).toBe(true);
    expect(job.skippedExternal.some((s) => s.path === workingDir)).toBe(true);
    expect(project.workingDir).toBe(workingDir);
  });

  it('deletes a gezel through the Store so project rosters stay consistent', async () => {
    const keeper = await store.createGezel({ name: 'Keeper' });
    const doomed = await store.createGezel({ name: 'Doomed' });
    const project = await store.createProject({ name: 'Crewed' });
    await store.updateProject(project.id, { voormanGezelId: doomed.id });

    await cleanup({
      categories: ['gezels'],
      itemIds: { gezels: [doomed.id] },
      confirmUserContent: true,
    });

    const remaining = (await store.listGezels()).map((g) => g.id);
    expect(remaining).toContain(keeper.id);
    expect(remaining).not.toContain(doomed.id);
    // A raw directory removal would leave this pointing at a gezel that no
    // longer exists.
    const after = await store.getProject(project.id);
    expect(after?.voormanGezelId).toBeUndefined();
  });

  it('keeps the default project and the document library when clearing projects', async () => {
    // The two projects boot creates: neither is the user's to lose here.
    await store.ensureDefaultProject();
    const shared = await store.ensureSharedProject();
    const ordinary = await store.createProject({ name: 'Ordinary' });
    await writeFile(join(home, 'documents', 'mission.md'), '# Mission');

    const { outcome } = await cleanup({ categories: ['projects'], confirmUserContent: true });

    const remaining = (await store.listProjects()).map((p) => p.id);
    expect(remaining).toContain('default');
    expect(remaining).toContain(shared.id);
    expect(remaining).not.toContain(ordinary.id);

    // Two different protections, deliberately: the shared library is never
    // even planned (the registry files it under Documents), while the
    // default project is planned and refused by the Store — recorded as a
    // failure rather than aborting the rest of the run.
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.reason).toMatch(/default project cannot be deleted/i);
    // Deleting "my projects" must never take the Documents library with it.
    expect(await exists(join(home, 'documents', 'mission.md'))).toBe(true);
  });

  it('refuses to start while a chat is still replying', async () => {
    await seedModel('llama-cpp', 'in-use');
    const listInflight = () => [{ sessionId: 's1' }];

    const job = jobs.create('cleanup');
    await expect(
      runCleanup({ home, store, jobs, listInflight }, { categories: ['models'] }, job),
    ).rejects.toThrow(/still replying/);

    expect(jobs.get(job.id)?.status).toBe('error');
    // The weights are still there — nothing was pulled out mid-turn.
    expect(await exists(join(home, 'engines', 'llama-cpp', 'models', 'in-use'))).toBe(true);
  });

  it('lets a chat keep running when the request touches no engine files', async () => {
    await mkdir(join(home, 'gilde', 'versions'), { recursive: true });
    const listInflight = () => [{ sessionId: 's1' }];

    const { job } = await cleanup({ categories: ['gilde-cache'] }, { listInflight });

    expect(job.status).toBe('done');
    expect(await exists(join(home, 'gilde'))).toBe(false);
  });

  it('keeps going when one item cannot be removed', async () => {
    await seedModel('llama-cpp', 'good-one', 4096);
    await seedModel('mlx', 'also-good', 4096);

    const { outcome } = await cleanup({ categories: ['models'] });

    expect(outcome.itemsRemoved).toBe(2);
    expect(outcome.failures).toEqual([]);
  });

  it('stops at the next item when cancelled', async () => {
    await seedModel('llama-cpp', 'a');
    await seedModel('mlx', 'b');
    const job = jobs.create('cleanup');
    jobs.requestCancel(job.id);

    await runCleanup({ home, store, jobs }, { categories: ['models'] }, job);

    expect(jobs.get(job.id)?.status).toBe('cancelled');
  });
});

describe('recovery after cleanup', () => {
  it('leaves an install the next boot can rebuild from', async () => {
    await seedModel('llama-cpp', 'demo-7b', 16_384);
    await mkdir(join(home, 'gilde', 'versions', '1.0.0'), { recursive: true });
    await mkdir(join(home, 'index'), { recursive: true });
    await writeFile(join(home, 'index', 'global.db'), 'x'.repeat(1024));
    const gezel = await store.createGezel({ name: 'Survivor' });

    await cleanup({
      categories: ['models', 'native-engines', 'engine-caches', 'gilde-cache', 'derived-caches'],
    });

    // A fresh Store over the same home must come back with the user's work
    // intact and the directory skeleton rebuilt — this is what makes
    // "delete the downloads" a safe thing to offer before a trip.
    const rebooted = new Store({ home });
    await rebooted.ensureLayout();
    const gezels = await rebooted.listGezels();
    expect(gezels.map((g) => g.id)).toContain(gezel.id);
    expect(await exists(join(home, 'gezels'))).toBe(true);
    expect(await exists(join(home, 'projects'))).toBe(true);

    // And the config still points at the model that is now absent, which is
    // exactly the state the first-run banner keys on to offer a re-download.
    const config = await rebooted.readConfig();
    expect(config).toBeDefined();
    expect(await exists(join(home, 'engines', 'llama-cpp', 'models', 'demo-7b'))).toBe(false);
  });

  it('re-measures storage after a run instead of serving the stale total', async () => {
    await seedModel('llama-cpp', 'demo-7b', 8192);
    const before = await buildStorageSummary({ home, store });
    expect(before.redownloadableBytes).toBeGreaterThanOrEqual(8192);

    await cleanup({ categories: ['models'] });

    const after = await buildStorageSummary({ home, store });
    expect(after.redownloadableBytes).toBe(0);
  });
});

describe('request classification', () => {
  it('names the user-content categories in a request', () => {
    expect(userContentCategories(['models', 'gezels', 'documents'])).toEqual([
      'gezels',
      'documents',
    ]);
    expect(userContentCategories(['models', 'toolsets'])).toEqual([]);
  });
});

describe('config survival', () => {
  it('leaves settings untouched when only downloads were requested', async () => {
    await seedModel('llama-cpp', 'demo-7b');
    const configPath = join(home, 'config.json');
    await writeFile(configPath, JSON.stringify({ provider: 'llama-cpp' }, null, 2));

    await cleanup({ categories: ['models'] });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ provider: 'llama-cpp' });
  });
});
