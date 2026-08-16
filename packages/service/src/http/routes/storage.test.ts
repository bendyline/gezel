import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageJobSchema, StorageSummarySchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../fs/store.js';
import { StorageJobManager } from '../../storage/job-manager.js';
import { invalidateStorageSummary } from '../../storage/summary.js';
import type { ServiceContext } from '../context.js';
import { storageRoutes } from './storage.js';

let home: string;
let store: Store;
let storageJobs: StorageJobManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-storage-route-'));
  store = new Store({ home });
  await store.ensureLayout();
  storageJobs = new StorageJobManager();
  invalidateStorageSummary();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function app(over: Partial<ServiceContext> = {}) {
  return storageRoutes({ store, storageJobs, ...over } as unknown as ServiceContext);
}

async function post(path: string, body?: unknown, over: Partial<ServiceContext> = {}) {
  return app(over).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Poll until the background job settles, so assertions see the end state. */
async function settle(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = storageJobs.get(jobId);
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('GET /api/storage/summary', () => {
  it('returns a schema-valid summary for a fresh install', async () => {
    const response = await app().request('/summary');
    expect(response.status).toBe(200);
    const body = StorageSummarySchema.parse(await response.json());
    expect(body.home).toBe(home);
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.redownloadableBytes).toBe(0);
  });

  it('reports downloaded models under the re-downloadable total', async () => {
    const modelDir = join(home, 'engines', 'mlx', 'models', 'demo');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'weights.safetensors'), 'x'.repeat(2048));

    const response = await app().request('/summary?refresh=1');
    const body = StorageSummarySchema.parse(await response.json());
    expect(body.redownloadableBytes).toBeGreaterThanOrEqual(2048);
    const models = body.categories.find((c) => c.id === 'models');
    expect(models?.items?.some((i) => i.id === 'mlx/demo')).toBe(true);
  });

  it('serves cached sizes until a refresh is asked for', async () => {
    const first = StorageSummarySchema.parse(await (await app().request('/summary')).json());

    const modelDir = join(home, 'engines', 'llama-cpp', 'models', 'late-arrival');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'weights.gguf'), 'x'.repeat(4096));

    const cached = StorageSummarySchema.parse(await (await app().request('/summary')).json());
    expect(cached.measuredAt).toBe(first.measuredAt);

    const refreshed = StorageSummarySchema.parse(
      await (await app().request('/summary?refresh=1')).json(),
    );
    expect(refreshed.redownloadableBytes).toBeGreaterThanOrEqual(4096);
  });

  it('never marks program files or code checkouts deletable', async () => {
    const response = await app().request('/summary');
    const body = StorageSummarySchema.parse(await response.json());
    for (const id of ['service-bundle', 'runtimes', 'git-clones']) {
      expect(body.categories.find((c) => c.id === id)?.deletable).toBe(false);
    }
  });
});

describe('POST /api/storage/cleanup', () => {
  async function seedModel(engine = 'llama-cpp', id = 'demo') {
    const dir = join(home, 'engines', engine, 'models', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'weights.gguf'), 'x'.repeat(4096));
    return dir;
  }

  it('starts a job and frees the requested downloads', async () => {
    const dir = await seedModel();

    const response = await post('/cleanup', { categories: ['models'] });
    expect(response.status).toBe(200);
    const { jobId } = (await response.json()) as { jobId: string };

    const job = await settle(jobId);
    expect(job.status).toBe('done');
    expect(await exists(dir)).toBe(false);
  });

  it('refuses to delete user content without an explicit confirmation', async () => {
    const response = await post('/cleanup', { categories: ['gezels'] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'confirm-required',
      categories: ['gezels'],
    });
  });

  it('accepts user content once confirmed', async () => {
    await store.createGezel({ name: 'Doomed' });
    const response = await post('/cleanup', {
      categories: ['gezels'],
      confirmUserContent: true,
    });
    expect(response.status).toBe(200);
    const { jobId } = (await response.json()) as { jobId: string };
    await settle(jobId);
    expect(await store.listGezels()).toEqual([]);
  });

  it('rejects categories the daemon runs from', async () => {
    const response = await post('/cleanup', { categories: ['service-bundle'] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'not-deletable' });
  });

  it('rejects a malformed request', async () => {
    const response = await post('/cleanup', { categories: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid-request' });
  });

  it('refuses a second cleanup while one is running', async () => {
    storageJobs.create('cleanup');
    const response = await post('/cleanup', { categories: ['models'] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'job-in-progress' });
  });

  it('refuses to start while a folder move is in flight', async () => {
    // Both rewrite the same trees; one would delete what the other copies.
    const folderJobs = { hasActive: () => true } as unknown as ServiceContext['folderJobs'];
    const response = await post('/cleanup', { categories: ['models'] }, { folderJobs });
    expect(response.status).toBe(409);
  });

  it('reports a run that could not start as a failed job, not a failed request', async () => {
    await seedModel();
    const chat = { listInflight: () => [{ sessionId: 's1' }] } as unknown as ServiceContext['chat'];

    const response = await post('/cleanup', { categories: ['models'] }, { chat });
    expect(response.status).toBe(200);

    const { jobId } = (await response.json()) as { jobId: string };
    const job = await settle(jobId);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/still replying/);
  });
});

describe('cleanup job polling', () => {
  it('serves a schema-valid job and 404s an unknown id', async () => {
    const job = storageJobs.create('cleanup');
    const response = await app().request(`/cleanup/${job.id}`);
    expect(response.status).toBe(200);
    expect(StorageJobSchema.parse(await response.json()).id).toBe(job.id);

    expect((await app().request('/cleanup/nope')).status).toBe(404);
  });

  it('cancels a live job and refuses to cancel a finished one', async () => {
    const job = storageJobs.create('cleanup');
    expect((await post(`/cleanup/${job.id}/cancel`)).status).toBe(200);

    storageJobs.finish(job.id, {});
    expect((await post(`/cleanup/${job.id}/cancel`)).status).toBe(409);
  });
});
