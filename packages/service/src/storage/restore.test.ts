import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RestoreReview } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as yazl from 'yazl';
import { Store } from '../fs/store.js';
import { runBackup } from './backup.js';
import { StorageJobManager } from './job-manager.js';
import { cancelRestore, readReview, runRestore, scanRestore } from './restore.js';

let home: string;
let out: string;
let store: Store;
let jobs: StorageJobManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-restore-'));
  out = await mkdtemp(join(tmpdir(), 'gezel-restore-out-'));
  store = new Store({ home });
  await store.ensureLayout();
  jobs = new StorageJobManager();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

function deps() {
  return { home, store, jobs };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Back up the current home to a file and return its path. */
async function makeBackup(name = 'backup.zip'): Promise<string> {
  const file = join(out, name);
  const job = jobs.create('backup');
  await runBackup({ home, store, jobs, version: '1.2.3' }, { outPath: file }, job);
  return file;
}

async function restore(review: RestoreReview, confirm: Parameters<typeof runRestore>[2]) {
  const job = jobs.create('restore');
  const result = await runRestore(deps(), review, confirm, job);
  return { result, job: jobs.get(job.id)! };
}

/** Every item, restored as an addition. */
function addAll(review: RestoreReview) {
  return { items: review.items.map((i) => ({ kind: i.kind, id: i.id, action: 'add' as const })) };
}

describe('scanRestore', () => {
  it('reports what a backup holds without touching the install', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();

    const review = await scanRestore(deps(), file);

    expect(review.items.some((i) => i.id === gezel.id)).toBe(true);
    expect(review.secretsExcluded).toBe(true);
    expect(review.warnings.some((w) => /credentials are never included/i.test(w))).toBe(true);
    // Still exactly one gezel — a scan reads, it does not write.
    expect(await store.listGezels()).toHaveLength(1);
  });

  it('flags items that already exist here', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();

    const review = await scanRestore(deps(), file);

    expect(review.items.find((i) => i.id === gezel.id)?.conflict).toBe('exists');
    expect(review.warnings.some((w) => /already exist/i.test(w))).toBe(true);
  });

  it('reports a file that is not a backup as such', async () => {
    const bogus = join(out, 'holiday.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('not a manifest'), 'readme.txt');
    zip.end();
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(zip.outputStream, createWriteStream(bogus));

    await expect(scanRestore(deps(), bogus)).rejects.toThrow(/not a Gezel backup/);
  });

  it('refuses a file that is not a zip at all', async () => {
    const notZip = join(out, 'notes.txt');
    await writeFile(notZip, 'just some text');
    await expect(scanRestore(deps(), notZip)).rejects.toThrow(/not a readable ZIP/);
  });
});

describe('runRestore', () => {
  it('brings a deleted gezel back, prose and all', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    await writeFile(join(home, 'gezels', gezel.id, 'about.md'), '# Who I am\n\nThe archivist.');
    const file = await makeBackup();

    await store.deleteGezel(gezel.id);
    expect(await store.listGezels()).toHaveLength(0);

    const review = await scanRestore(deps(), file);
    const { job } = await restore(review, addAll(review));

    expect(job.status).toBe('done');
    const rebooted = new Store({ home });
    expect((await rebooted.listGezels()).map((g) => g.id)).toContain(gezel.id);
    expect(await readFile(join(home, 'gezels', gezel.id, 'about.md'), 'utf8')).toContain(
      'The archivist.',
    );
  });

  it('asks for a restart, because the running daemon caches records', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();
    await store.deleteGezel(gezel.id);

    const review = await scanRestore(deps(), file);
    const { job } = await restore(review, addAll(review));

    expect(job.restartRequired).toBe(true);
  });

  it('refuses to overwrite something that already exists unless told to', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();

    const review = await scanRestore(deps(), file);
    await expect(
      restore(review, {
        items: [{ kind: 'gezel', id: gezel.id, action: 'add' }],
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('replaces an existing item when asked by name', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const aboutPath = join(home, 'gezels', gezel.id, 'about.md');
    await writeFile(aboutPath, 'ORIGINAL');
    const file = await makeBackup();

    await writeFile(aboutPath, 'CHANGED SINCE THE BACKUP');
    const review = await scanRestore(deps(), file);
    await restore(review, { items: [{ kind: 'gezel', id: gezel.id, action: 'replace' }] });

    expect(await readFile(aboutPath, 'utf8')).toBe('ORIGINAL');
  });

  it('leaves unselected items exactly as they were', async () => {
    const keep = await store.createGezel({ name: 'Keep' });
    const other = await store.createGezel({ name: 'Other' });
    await writeFile(join(home, 'gezels', other.id, 'about.md'), 'LIVE VERSION');
    const file = await makeBackup();
    await store.deleteGezel(keep.id);

    const review = await scanRestore(deps(), file);
    await restore(review, { items: [{ kind: 'gezel', id: keep.id, action: 'add' }] });

    // The gezel nobody asked about keeps its current content, not the
    // archived one — a restore is not a rollback of everything.
    expect(await readFile(join(home, 'gezels', other.id, 'about.md'), 'utf8')).toBe('LIVE VERSION');
  });

  it('restores documents into this install’s location, not the backup’s', async () => {
    await writeFile(join(home, 'documents', 'mission.md'), '# Mission');
    const file = await makeBackup();
    await rm(join(home, 'documents', 'mission.md'));

    const review = await scanRestore(deps(), file);
    await restore(review, addAll(review));

    expect(await readFile(join(home, 'documents', 'mission.md'), 'utf8')).toContain('# Mission');
  });

  it('never applies another machine’s folder locations', async () => {
    // The dangerous direction: a backup made on a machine that kept its
    // gezels on an external drive. Applying that path here would send this
    // install looking for its content somewhere that does not exist.
    const foreignPath = join(out, 'machine-a-external-drive');
    await store.writeConfig({
      provider: 'llama-cpp',
      externalFolders: { gezels: foreignPath },
    });
    const file = await makeBackup();

    // A different install: same content, no external folders of its own.
    const targetHome = await mkdtemp(join(tmpdir(), 'gezel-restore-target-'));
    try {
      const targetStore = new Store({ home: targetHome });
      await targetStore.ensureLayout();
      const targetDeps = { home: targetHome, store: targetStore, jobs };

      const review = await scanRestore(targetDeps, file);
      const job = jobs.create('restore');
      await runRestore(targetDeps, review, { ...addAll(review), settings: true }, job);

      const config = (await targetStore.readConfig()) as Record<string, unknown>;
      expect(config.externalFolders).toBeUndefined();
      // The rest of the settings still come across.
      expect(config.provider).toBe('llama-cpp');
    } finally {
      await rm(targetHome, { recursive: true, force: true });
    }
  });

  it('clears its staging once the restore lands', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();
    await store.deleteGezel(gezel.id);

    const review = await scanRestore(deps(), file);
    await restore(review, addAll(review));

    expect(await exists(join(home, '.transactions', 'backup-restores', review.restoreId))).toBe(
      false,
    );
  });

  it('keeps the review readable until it is used or cancelled', async () => {
    await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();

    const review = await scanRestore(deps(), file);
    expect((await readReview(home, review.restoreId))?.restoreId).toBe(review.restoreId);

    await cancelRestore(home, review.restoreId);
    expect(await readReview(home, review.restoreId)).toBeNull();
  });
});

describe('full round trip', () => {
  it('rebuilds a wiped install from its backup', async () => {
    // The scenario the feature exists for: back up, clear everything out,
    // then get the work back.
    const gezel = await store.createGezel({ name: 'Archivist' });
    await writeFile(join(home, 'gezels', gezel.id, 'about.md'), 'THE ARCHIVIST');
    const project = await store.createProject({ name: 'Roof Survey' });
    await mkdir(join(home, 'projects', project.id, 'workspace'), { recursive: true });
    await writeFile(join(home, 'projects', project.id, 'workspace', 'notes.md'), 'FIELD NOTES');
    await writeFile(join(home, 'documents', 'mission.md'), 'THE MISSION');

    const file = await makeBackup();

    await store.deleteGezel(gezel.id);
    await store.deleteProject(project.id, { removeWorkspace: true });
    await rm(join(home, 'documents', 'mission.md'));

    const review = await scanRestore(deps(), file);
    const { result } = await restore(review, addAll(review));

    expect(result.restored).toBeGreaterThanOrEqual(3);
    const rebooted = new Store({ home });
    await rebooted.ensureLayout();
    expect((await rebooted.listGezels()).map((g) => g.id)).toContain(gezel.id);
    expect((await rebooted.listProjects()).map((p) => p.id)).toContain(project.id);
    expect(await readFile(join(home, 'gezels', gezel.id, 'about.md'), 'utf8')).toBe(
      'THE ARCHIVIST',
    );
    expect(
      await readFile(join(home, 'projects', project.id, 'workspace', 'notes.md'), 'utf8'),
    ).toBe('FIELD NOTES');
    expect(await readFile(join(home, 'documents', 'mission.md'), 'utf8')).toBe('THE MISSION');
  });
});
