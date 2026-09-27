import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
async function makeBackup(name = 'backup.zip', request: { excludeWorkspaces?: boolean } = {}) {
  const file = join(out, name);
  const job = jobs.create('backup');
  await runBackup({ home, store, jobs, version: '1.2.3' }, { outPath: file, ...request }, job);
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

  it('keeps documents added to the library since the backup', async () => {
    // The library is often the person's cloud-synced folder; swapping it for
    // the backup's copy deleted everything filed since, on every device.
    await writeFile(join(home, 'documents', 'mission.md'), '# Mission');
    const file = await makeBackup();
    await mkdir(join(home, 'documents', 'clients'), { recursive: true });
    await writeFile(join(home, 'documents', 'clients', 'acme.md'), 'FILED AFTER THE BACKUP');

    const review = await scanRestore(deps(), file);
    expect(review.items.find((i) => i.kind === 'document-root')?.conflict).toBe('none');
    expect(review.warnings.some((w) => /nothing there is removed or replaced/.test(w))).toBe(true);
    const { job } = await restore(review, addAll(review));

    expect(job.status).toBe('done');
    expect(await readFile(join(home, 'documents', 'clients', 'acme.md'), 'utf8')).toBe(
      'FILED AFTER THE BACKUP',
    );
    expect(await readFile(join(home, 'documents', 'mission.md'), 'utf8')).toBe('# Mission');
  });

  it('keeps the live version of a changed document and saves the backup’s beside it', async () => {
    const mission = join(home, 'documents', 'mission.md');
    await writeFile(mission, 'AS BACKED UP');
    const file = await makeBackup();
    await writeFile(mission, 'EDITED SINCE');

    const review = await scanRestore(deps(), file);
    await restore(review, addAll(review));
    // Restoring the same backup twice adds nothing more.
    const again = await scanRestore(deps(), file);
    await restore(again, addAll(again));

    expect(await readFile(mission, 'utf8')).toBe('EDITED SINCE');
    const day = new Date().toISOString().slice(0, 10);
    const names = (await readdir(join(home, 'documents'))).filter((n) => n.startsWith('mission'));
    expect(names.sort()).toEqual([`mission (from backup ${day}).md`, 'mission.md']);
    expect(await readFile(join(home, 'documents', `mission (from backup ${day}).md`), 'utf8')).toBe(
      'AS BACKED UP',
    );
  });

  it('keeps working files a backup left out when a project is replaced', async () => {
    const project = await store.createProject({ name: 'Roof Survey' });
    const dir = join(home, 'projects', project.id);
    await writeFile(join(dir, 'workspace', 'notes.md'), 'FIELD NOTES');
    const file = await makeBackup('no-workspaces.zip', { excludeWorkspaces: true });
    await writeFile(join(dir, 'workspace', 'later.md'), 'WRITTEN AFTER THE BACKUP');

    const review = await scanRestore(deps(), file);
    expect(review.warnings.some((w) => /keeps the working files/.test(w))).toBe(true);
    const { job } = await restore(review, {
      items: [{ kind: 'project', id: project.id, action: 'replace' }],
    });

    expect(job.status).toBe('done');
    expect(await readFile(join(dir, 'workspace', 'notes.md'), 'utf8')).toBe('FIELD NOTES');
    expect(await readFile(join(dir, 'workspace', 'later.md'), 'utf8')).toBe(
      'WRITTEN AFTER THE BACKUP',
    );
    expect(await exists(join(dir, 'project.json'))).toBe(true);
    expect((await readdir(join(home, 'projects'))).some((n) => n.includes('restore-'))).toBe(false);
  });

  it('keeps working files when the backup’s copy of the project had none', async () => {
    // Older backups never recorded that working files were left out; all
    // they show is a project with no working files in it.
    const project = await store.createProject({ name: 'Roof Survey' });
    const workspace = join(home, 'projects', project.id, 'workspace');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace);
    const file = await makeBackup();
    await writeFile(join(workspace, 'later.md'), 'WRITTEN AFTER THE BACKUP');

    const review = await scanRestore(deps(), file);
    await restore(review, { items: [{ kind: 'project', id: project.id, action: 'replace' }] });

    expect(await readFile(join(workspace, 'later.md'), 'utf8')).toBe('WRITTEN AFTER THE BACKUP');
  });

  it('still rolls working files back when the backup carries them', async () => {
    const project = await store.createProject({ name: 'Roof Survey' });
    const notes = join(home, 'projects', project.id, 'workspace', 'notes.md');
    await writeFile(notes, 'AS BACKED UP');
    const file = await makeBackup();
    await writeFile(notes, 'CHANGED SINCE');

    const review = await scanRestore(deps(), file);
    await restore(review, { items: [{ kind: 'project', id: project.id, action: 'replace' }] });

    expect(await readFile(notes, 'utf8')).toBe('AS BACKED UP');
  });

  it('brings back house roles, never this device’s providers, folders or security', async () => {
    // A config names engines, listeners and the security level. A backup
    // from another machine, or a crafted one, must not be able to set them.
    const meester = await store.createGezel({ name: 'Meester' });
    await store.writeConfig({
      provider: 'llama-cpp',
      externalFolders: { gezels: join(out, 'machine-a-external-drive') },
      mlxPackageSpec: 'mlx-lm @ https://example.invalid/evil.whl',
      meesterGezelId: meester.id,
      roleBasedNameOnlyMode: true,
    });
    const file = await makeBackup();

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
      expect(config.provider).toBeUndefined();
      expect(config.mlxPackageSpec).toBeUndefined();
      expect(config.meesterGezelId).toBe(meester.id);
      expect(config.roleBasedNameOnlyMode).toBe(true);
    } finally {
      await rm(targetHome, { recursive: true, force: true });
    }
  });

  it('drops a role pointing at a gezel the restore did not bring', async () => {
    const meester = await store.createGezel({ name: 'Meester' });
    const other = await store.createGezel({ name: 'Other' });
    await store.writeConfig({ meesterGezelId: meester.id });
    const file = await makeBackup();
    await store.writeConfig({ meesterGezelId: other.id });
    await store.deleteGezel(meester.id);

    const review = await scanRestore(deps(), file);
    const content = review.items.filter((i) => i.kind === 'settings-file');
    await restore(review, {
      items: content.map((i) => ({ kind: i.kind, id: i.id, action: 'add' as const })),
      settings: true,
    });

    expect((await store.readConfig()).meesterGezelId).toBe(other.id);
  });

  it('stops before changing anything when the settings cannot be used', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const configPath = join(home, 'config.json');
    await writeFile(configPath, JSON.stringify({ roleBasedNameOnlyMode: 'yes' }));
    const file = await makeBackup();
    await rm(configPath);
    await store.deleteGezel(gezel.id);

    const review = await scanRestore(deps(), file);
    await expect(restore(review, { ...addAll(review), settings: true })).rejects.toThrow(
      /not valid/,
    );
    expect(await exists(join(home, 'gezels', gezel.id))).toBe(false);
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
