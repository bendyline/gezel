import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManifestSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as yauzl from 'yauzl';
import { Store } from '../fs/store.js';
import { planBackup, runBackup } from './backup.js';
import { StorageJobManager } from './job-manager.js';

let home: string;
let out: string;
let store: Store;
let jobs: StorageJobManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-backup-'));
  out = await mkdtemp(join(tmpdir(), 'gezel-backup-out-'));
  store = new Store({ home });
  await store.ensureLayout();
  jobs = new StorageJobManager();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

function deps() {
  return { home, store, jobs, version: '1.2.3' };
}

async function backupTo(file: string, request: Record<string, unknown> = {}) {
  const job = jobs.create('backup');
  const result = await runBackup(deps(), { outPath: file, ...request }, job);
  return { result, job: jobs.get(job.id)! };
}

/** Every entry path inside the archive. */
async function entriesOf(archive: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const names: string[] = [];
    yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('no zip'));
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolvePromise(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function readEntry(archive: string, name: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('no zip'));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== name) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        });
      });
      zip.on('end', () => reject(new Error(`entry not found: ${name}`)));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('planBackup', () => {
  it('lists the user’s work and says secrets are excluded', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    await store.createProject({ name: 'Roof Survey' });

    const plan = await planBackup(deps());

    expect(plan.secretsExcluded).toBe(true);
    expect(plan.items.some((i) => i.kind === 'gezel' && i.id === gezel.id)).toBe(true);
    expect(plan.items.some((i) => i.kind === 'project')).toBe(true);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });

  it('reports the destination’s free space when asked about one', async () => {
    await store.createGezel({ name: 'Archivist' });
    const plan = await planBackup(deps(), { destPath: join(out, 'backup.zip') });
    expect(plan.destFreeBytes).toBeGreaterThan(0);
  });
});

describe('runBackup', () => {
  it('writes an archive with a manifest describing what it holds', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const file = join(out, 'backup.zip');

    const { result, job } = await backupTo(file);

    expect(job.status).toBe('done');
    const manifest = BackupManifestSchema.parse(JSON.parse(await readEntry(file, 'manifest.json')));
    expect(manifest.kind).toBe('gezel-backup');
    expect(manifest.gezelVersion).toBe('1.2.3');
    expect(manifest.items.some((i) => i.id === gezel.id)).toBe(true);
    expect(result.manifest.secretsExcluded).toBe(true);
  });

  it('never carries device-bound credentials into a portable file', async () => {
    // These are meaningless on another machine and a liability in a file
    // someone emails to themselves.
    await store.createGezel({ name: 'Archivist' });
    await writeFile(join(home, 'secrets.enc'), 'ENCRYPTED-SECRET-MATERIAL');
    await writeFile(join(home, 'secrets.key'), 'KEY-MATERIAL');
    await writeFile(join(home, 'tokens.json'), '{"github":"ghp_realtoken"}');
    await writeFile(join(home, 'remotes.json'), '{"peer":"bearer-token"}');
    await writeFile(join(home, 'device-identity.json'), '{"key":"device"}');

    const file = join(out, 'backup.zip');
    await backupTo(file);

    const entries = await entriesOf(file);
    for (const secret of [
      'secrets.enc',
      'secrets.key',
      'tokens.json',
      'remotes.json',
      'device-identity.json',
    ]) {
      expect(entries.some((e) => e.includes(secret))).toBe(false);
    }
  });

  it('carries the gezel’s prose and chat history', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    await writeFile(join(home, 'gezels', gezel.id, 'about.md'), '# Who I am\n\nThe archivist.');

    const file = join(out, 'backup.zip');
    await backupTo(file);

    expect(await readEntry(file, `gezels/${gezel.id}/about.md`)).toContain('The archivist.');
  });

  it('leaves out the indexes a fresh install rebuilds', async () => {
    const gezel = await store.createGezel({ name: 'Archivist' });
    const indexDir = join(home, 'gezels', gezel.id, 'memories', 'index');
    await mkdir(indexDir, { recursive: true });
    await writeFile(join(indexDir, 'mem.db'), 'x'.repeat(50_000));

    const file = join(out, 'backup.zip');
    await backupTo(file);

    const entries = await entriesOf(file);
    expect(entries.some((e) => e.includes('memories/index'))).toBe(false);
  });

  it('includes project working files by default and omits them on request', async () => {
    const project = await store.createProject({ name: 'Roof Survey' });
    await writeFile(join(home, 'projects', project.id, 'workspace', 'notes.md'), '# Notes');

    const withWorkspace = join(out, 'with.zip');
    await backupTo(withWorkspace);
    expect((await entriesOf(withWorkspace)).some((e) => e.endsWith('workspace/notes.md'))).toBe(
      true,
    );

    const without = join(out, 'without.zip');
    await backupTo(without, { excludeWorkspaces: true });
    expect((await entriesOf(without)).some((e) => e.endsWith('workspace/notes.md'))).toBe(false);
  });

  it('backs up only what the request selected', async () => {
    const keep = await store.createGezel({ name: 'Keep' });
    const skip = await store.createGezel({ name: 'Skip' });

    const file = join(out, 'partial.zip');
    await backupTo(file, { include: { gezels: [keep.id], documents: false, settings: false } });

    const entries = await entriesOf(file);
    expect(entries.some((e) => e.startsWith(`gezels/${keep.id}/`))).toBe(true);
    expect(entries.some((e) => e.startsWith(`gezels/${skip.id}/`))).toBe(false);
  });

  it('stores a single-file item at its own name, not nested under itself', async () => {
    // `settings/config.json/config.json` looks harmless in a listing but
    // means restore finds nothing where it looks, so settings silently never
    // come back.
    await store.writeConfig({ provider: 'llama-cpp' });

    const file = join(out, 'settings.zip');
    await backupTo(file);

    const entries = await entriesOf(file);
    expect(entries).toContain('settings/config.json');
    expect(entries.some((e) => e.includes('config.json/config.json'))).toBe(false);
  });

  it('archives the document library under its own prefix', async () => {
    await writeFile(join(home, 'documents', 'mission.md'), '# Mission');

    const file = join(out, 'docs.zip');
    await backupTo(file);

    expect(await readEntry(file, 'documents/mission.md')).toContain('# Mission');
  });

  it('leaves no file behind when the run fails', async () => {
    // Nothing to archive is a failure, not an empty archive that looks like
    // a successful backup of an empty account.
    const file = join(out, 'empty.zip');
    const job = jobs.create('backup');
    await expect(
      runBackup(
        deps(),
        { outPath: file, include: { gezels: [], documents: false, settings: false } },
        job,
      ),
    ).rejects.toThrow(/Nothing selected/);

    const { access } = await import('node:fs/promises');
    await expect(access(file)).rejects.toThrow();
    await expect(access(`${file}.partial`)).rejects.toThrow();
    expect(jobs.get(job.id)?.status).toBe('error');
  });

  it('records where the source install kept its folders, for diagnosis only', async () => {
    await store.createGezel({ name: 'Archivist' });
    const file = join(out, 'backup.zip');
    const { result } = await backupTo(file);
    // Null here means "this install used the default layout" — restore never
    // applies these paths regardless.
    expect(result.manifest.externalFolders).toBeNull();
  });
});
