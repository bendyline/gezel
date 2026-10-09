import { mkdirSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RestoreReview } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yazl from 'yazl';
import { Store } from '../fs/store.js';
import { runBackup } from './backup.js';
import { StorageJobManager } from './job-manager.js';
import { cancelRestore, readReview, runRestore, scanRestore } from './restore.js';

const faults = vi.hoisted(() => ({
  copyFrom: '',
  renameFrom: '',
  renameCode: 'EIO',
  beforeRenameFrom: '',
  beforeRename: (): void => {},
  calls: { cp: [] as string[], rename: [] as Array<[string, string]> },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    // The faulted copy lands its bytes first, like a disk filling on the last
    // file, so there is a partial tree for the code under test to clean up.
    cp: async (...args: Parameters<typeof fs.cp>) => {
      faults.calls.cp.push(String(args[0]));
      await fs.cp(...args);
      if (String(args[0]) === faults.copyFrom)
        throw Object.assign(new Error('copy interrupted'), { code: 'EIO' });
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      faults.calls.rename.push([String(args[0]), String(args[1])]);
      if (String(args[0]) === faults.beforeRenameFrom) faults.beforeRename();
      if (String(args[0]) === faults.renameFrom)
        throw Object.assign(new Error('rename failed'), { code: faults.renameCode });
      return fs.rename(...args);
    },
  };
});

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
  faults.copyFrom = '';
  faults.renameFrom = '';
  faults.renameCode = 'EIO';
  faults.beforeRenameFrom = '';
  faults.beforeRename = () => {};
  faults.calls.cp.length = 0;
  faults.calls.rename.length = 0;
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

/** Where a gezel or project waits in staging before it is published. */
function stagedItem(review: RestoreReview, kind: 'gezels' | 'projects', id: string): string {
  return join(home, '.transactions', 'backup-restores', review.restoreId, 'stage', kind, id);
}

/** Parked, rejected or half-copied siblings a restore left beside its items. */
async function restoreLeftovers(kind: 'gezels' | 'projects'): Promise<string[]> {
  return (await readdir(join(home, kind))).filter((name) => name.includes('restore-'));
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
  it('moves a same-volume addition into place in one rename and leaves no staging', async () => {
    const project = await store.createProject({ name: 'Roof Survey' });
    const target = join(home, 'projects', project.id);
    await writeFile(join(target, 'workspace', 'notes.md'), 'FIELD NOTES');
    const file = await makeBackup();
    await store.deleteProject(project.id, { removeWorkspace: true });
    const review = await scanRestore(deps(), file);
    const staged = stagedItem(review, 'projects', project.id);

    const { job } = await restore(review, {
      items: [{ kind: 'project', id: project.id, action: 'add' }],
    });

    expect(job.status).toBe('done');
    expect(faults.calls.rename).toContainEqual([staged, target]);
    expect(faults.calls.cp.filter((source) => source.startsWith(staged))).toEqual([]);
    expect(await readFile(join(target, 'workspace', 'notes.md'), 'utf8')).toBe('FIELD NOTES');
    expect(await exists(join(home, '.transactions', 'backup-restores', review.restoreId))).toBe(
      false,
    );
    expect(await restoreLeftovers('projects')).toEqual([]);
  });

  it('leaves nothing at the target when a copy across volumes fails, so the review retries', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const target = join(home, 'gezels', gezel.id);
    await writeFile(join(target, 'about.md'), 'BACKED UP');
    const file = await makeBackup();
    await store.deleteGezel(gezel.id);
    const review = await scanRestore(deps(), file);
    const confirm = { items: [{ kind: 'gezel' as const, id: gezel.id, action: 'add' as const }] };
    const staged = stagedItem(review, 'gezels', gezel.id);
    faults.renameFrom = staged;
    faults.renameCode = 'EXDEV';
    faults.copyFrom = staged;

    const job = jobs.create('restore');
    await expect(runRestore(deps(), review, confirm, job)).rejects.toMatchObject({ code: 'EIO' });
    expect(jobs.get(job.id)?.status).toBe('error');
    expect(await exists(target)).toBe(false);
    expect(await restoreLeftovers('gezels')).toEqual([]);
    expect(await readFile(join(staged, 'about.md'), 'utf8')).toBe('BACKED UP');
    expect(await readReview(home, review.restoreId)).not.toBeNull();

    // Still across volumes, now with a copy that completes: an addition, not
    // a replacement, because the failed attempt left nothing in the way.
    faults.copyFrom = '';
    expect((await restore(review, confirm)).job.status).toBe('done');
    expect(await readFile(join(target, 'about.md'), 'utf8')).toBe('BACKED UP');
    expect(await restoreLeftovers('gezels')).toEqual([]);
    expect((await new Store({ home }).listGezels()).map((item) => item.id)).toContain(gezel.id);
  });

  it('keeps an item that appears just as the addition moves into place', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();
    await store.deleteGezel(gezel.id);
    const review = await scanRestore(deps(), file);
    const target = join(home, 'gezels', gezel.id);
    const staged = stagedItem(review, 'gezels', gezel.id);
    faults.beforeRenameFrom = staged;
    faults.beforeRename = () => {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'about.md'), 'new live work');
    };

    await expect(
      restore(review, { items: [{ kind: 'gezel', id: gezel.id, action: 'add' }] }),
    ).rejects.toThrow('refusing to overwrite');
    expect(await readFile(join(target, 'about.md'), 'utf8')).toBe('new live work');
    expect(await exists(join(target, 'gezel.md'))).toBe(false);
    expect(await exists(join(staged, 'gezel.md'))).toBe(true);
  });

  it('never replaces a file that appears where an addition goes', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = await makeBackup();
    await store.deleteGezel(gezel.id);
    const review = await scanRestore(deps(), file);
    const target = join(home, 'gezels', gezel.id);
    const original = jobs.setPhase.bind(jobs);
    const spy = vi.spyOn(jobs, 'setPhase').mockImplementation((...args) => {
      if (args[1] === 'publish' && !args[2]) writeFileSync(target, 'a file, not a gezel');
      return original(...args);
    });
    try {
      await expect(
        restore(review, { items: [{ kind: 'gezel', id: gezel.id, action: 'add' }] }),
      ).rejects.toThrow('refusing to overwrite');
      expect(await readFile(target, 'utf8')).toBe('a file, not a gezel');
    } finally {
      spy.mockRestore();
    }
  });

  it('rolls back a failed replacement and allows the same review to be retried', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const target = join(home, 'gezels', gezel.id);
    await writeFile(join(target, 'about.md'), 'BACKED UP');
    const file = await makeBackup();
    await writeFile(join(target, 'about.md'), 'CURRENT WORK');
    const review = await scanRestore(deps(), file);
    const confirm = {
      items: [{ kind: 'gezel' as const, id: gezel.id, action: 'replace' as const }],
    };
    faults.renameFrom = join(
      home,
      '.transactions',
      'backup-restores',
      review.restoreId,
      'stage',
      'gezels',
      gezel.id,
    );
    await expect(restore(review, confirm)).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(join(target, 'about.md'), 'utf8')).toBe('CURRENT WORK');
    expect(await readReview(home, review.restoreId)).not.toBeNull();
    expect(
      (await readdir(join(home, 'gezels'))).some((name) => name.includes('restore-parked')),
    ).toBe(false);
    faults.renameFrom = '';
    expect((await restore(review, confirm)).job.status).toBe('done');
    expect(await readFile(join(target, 'about.md'), 'utf8')).toBe('BACKED UP');
  });

  it.each(['after review', 'during publication'])(
    'does not replace an addition created %s',
    async (when) => {
      const gezel = await store.createGezel({ name: 'Archivist' });
      const file = await makeBackup();
      await store.deleteGezel(gezel.id);
      const review = await scanRestore(deps(), file);
      expect(review.items.find((item) => item.id === gezel.id)?.conflict).toBe('none');
      const target = join(home, 'gezels', gezel.id);
      const createLive = () => {
        mkdirSync(target);
        writeFileSync(join(target, 'about.md'), 'new live work');
      };
      const original = jobs.setPhase.bind(jobs);
      const spy = vi.spyOn(jobs, 'setPhase').mockImplementation((...args) => {
        if (when === 'during publication' && args[1] === 'publish' && !args[2]) createLive();
        return original(...args);
      });
      try {
        if (when === 'after review') createLive();
        await expect(
          restore(review, { items: [{ kind: 'gezel', id: gezel.id, action: 'add' }] }),
        ).rejects.toThrow('refusing to overwrite');
        expect(await readFile(join(target, 'about.md'), 'utf8')).toBe('new live work');
        expect(
          (await readdir(join(home, 'gezels'))).some((name) => name.includes('restore-parked')),
        ).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );

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

  it('adds the backup’s memories about the person to the ones here, removing none', async () => {
    await store.appendMemory('user', 'user', 'Lives in Utrecht.', 'fact');
    const file = await makeBackup();
    const day = (await store.listMemoryDays('user', 'user'))[0]!;
    await writeFile(
      join(home, 'memories', 'daily', `${day}.md`),
      '\n## 09:00 [pref]\n\nCycles to work.\n',
    );

    const review = await scanRestore(deps(), file);
    expect(review.items.find((i) => i.kind === 'memory-root')?.conflict).toBe('none');
    const { job } = await restore(review, addAll(review));

    expect(job.status).toBe('done');
    const merged = await store.readMemoryDay('user', 'user', day);
    expect(merged).toContain('Cycles to work.');
    expect(merged).toContain('Lives in Utrecht.');
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
