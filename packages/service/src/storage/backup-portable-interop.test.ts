import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { portableStoreOverHome } from '../test-support/portable-node-files.js';
import { runBackup } from './backup.js';
import { StorageJobManager } from './job-manager.js';
import { scanRestore } from './restore.js';

/**
 * A backup written by one host must be readable by the other. This is the
 * contract the shared backup policy exists for: the same archive prefixes,
 * the same derived-state exclusions, the same settings files.
 */
let home: string;
let out: string;
let store: Store;
let jobs: StorageJobManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-interop-'));
  out = await mkdtemp(join(tmpdir(), 'gezel-interop-out-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Alpha' });
  jobs = new StorageJobManager();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

const identities = (items: ReadonlyArray<{ kind: string; id: string }>) =>
  items.map((item) => `${item.kind}/${item.id}`).sort();

describe('backup archives cross hosts', () => {
  it('a desktop backup, history file included, is reviewable on the portable host', async () => {
    // The desktop has always carried its history file; the portable reader
    // used to refuse the whole archive over it.
    await writeFile(join(home, 'history.jsonl'), '{"event":"boot"}\n');
    const file = join(out, 'desktop.zip');
    const result = await runBackup(
      { home, store, jobs, version: '1.2.3' },
      { outPath: file },
      jobs.create('backup'),
    );
    const review = await portableStoreOverHome(
      await mkdtemp(join(tmpdir(), 'gezel-interop-target-')),
    ).scanRestore(new Uint8Array(await readFile(file)));
    expect(identities(review.items)).toEqual(identities(result.manifest.items));
    expect(identities(review.items)).toContain('settings-file/history.jsonl');
  });

  it('a portable backup is reviewable by the desktop restore', async () => {
    const exported = await portableStoreOverHome(home).exportBackup();
    const file = join(out, 'portable.zip');
    await writeFile(file, exported.bytes);
    const targetHome = await mkdtemp(join(tmpdir(), 'gezel-interop-target-'));
    const target = new Store({ home: targetHome });
    await target.ensureLayout();
    const review = await scanRestore({ home: targetHome, store: target, jobs }, file);
    expect(identities(review.items)).toEqual(identities(exported.manifest.items));
    await rm(targetHome, { recursive: true, force: true });
  });
});
