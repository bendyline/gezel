import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVICE_WORKER_ENTRIES,
  type ServiceWorkerEntry,
  findServiceWorkerEntry,
} from './service-worker-entry.js';

const workerNames = Object.keys(SERVICE_WORKER_ENTRIES) as ServiceWorkerEntry[];
const tempRoots: string[] = [];
const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const builtDaemonEntry = join(serviceRoot, 'dist', 'bin', 'gezeld.js');

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gezel-service-workers-'));
  tempRoots.push(root);
  return root;
}

async function touch(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'export {};\n');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('service worker entry resolution', () => {
  it('resolves every emitted worker from the embedded dist/index.js bundle', async () => {
    const root = await tempRoot();
    const entry = join(root, 'dist', 'index.js');
    await touch(entry);

    for (const name of workerNames) {
      const expected = join(root, 'dist', SERVICE_WORKER_ENTRIES[name].built);
      await touch(expected);
      expect(findServiceWorkerEntry(pathToFileURL(entry).href, name)).toBe(expected);
    }
  });

  it('resolves every emitted worker from the packaged dist/bin/gezeld.js bundle', async () => {
    const root = await tempRoot();
    const entry = join(root, 'dist', 'bin', 'gezeld.js');
    await touch(entry);

    for (const name of workerNames) {
      const expected = join(root, 'dist', SERVICE_WORKER_ENTRIES[name].built);
      await touch(expected);
      expect(findServiceWorkerEntry(pathToFileURL(entry).href, name)).toBe(expected);
    }
  });

  it('finds a built worker when running from a raw source entry', async () => {
    const root = await tempRoot();
    const entry = join(root, 'src', 'bin', 'gezeld.ts');
    const expected = join(root, 'dist', SERVICE_WORKER_ENTRIES['gguf-metadata'].built);
    await touch(entry);
    await touch(expected);

    expect(findServiceWorkerEntry(pathToFileURL(entry).href, 'gguf-metadata')).toBe(expected);
  });

  it('uses the TypeScript document worker in raw-source development', async () => {
    const root = await tempRoot();
    const entry = join(root, 'src', 'index-store', 'sandbox-convert.ts');
    const descriptor = SERVICE_WORKER_ENTRIES['document-convert'];
    const expected = join(root, 'src', descriptor.source);
    await touch(entry);
    await touch(expected);

    expect(findServiceWorkerEntry(pathToFileURL(entry).href, 'document-convert')).toBe(expected);
  });

  it('returns null when the requested worker is absent', async () => {
    const root = await tempRoot();
    const entry = join(root, 'dist', 'bin', 'gezeld.js');
    await touch(entry);

    expect(findServiceWorkerEntry(pathToFileURL(entry).href, 'static-index')).toBeNull();
  });

  it.skipIf(!existsSync(builtDaemonEntry))(
    'resolves every worker from the actual emitted daemon bundle',
    () => {
      for (const name of workerNames) {
        const expected = join(serviceRoot, 'dist', SERVICE_WORKER_ENTRIES[name].built);
        expect(existsSync(expected), `${name} worker should be emitted`).toBe(true);
        expect(findServiceWorkerEntry(pathToFileURL(builtDaemonEntry).href, name)).toBe(expected);
      }
    },
  );
});
