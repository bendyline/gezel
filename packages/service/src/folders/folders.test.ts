import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { JobManager } from './job-manager.js';
import { runMove } from './move-worker.js';
import { planMove } from './plan.js';
import { makeScopeFilter } from './scope.js';
import { validateExternalPath } from './validation.js';

let home: string;
let externalRoot: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-folders-'));
  externalRoot = await mkdtemp(join(tmpdir(), 'gezel-folders-ext-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
});

describe('validateExternalPath', () => {
  it('rejects a destination inside ~/.gezel', async () => {
    process.env.GEZEL_HOME = home;
    const result = await validateExternalPath('documents', join(home, 'inside'), undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/inside/);
    delete process.env.GEZEL_HOME;
  });

  it('rejects a relative path', async () => {
    const result = await validateExternalPath('documents', 'relative/path', undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/absolute/);
  });

  it('rejects overlap with another externalized scope', async () => {
    const result = await validateExternalPath('gezels', externalRoot, {
      documents: externalRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already used|overlaps/);
  });

  it('accepts a fresh writable folder', async () => {
    const dest = join(externalRoot, 'pickme');
    const result = await validateExternalPath('documents', dest, undefined);
    expect(result.ok).toBe(true);
  });
});

describe('makeScopeFilter', () => {
  it('keeps everything for documents', () => {
    const filter = makeScopeFilter('documents', '/src/documents', '/home');
    expect(filter('/src/documents/notes/foo.md')).toBe(true);
    expect(filter('/src/documents/anything')).toBe(true);
  });

  it('drops gezel toolsets/ and toolsets.json', () => {
    const filter = makeScopeFilter('gezels', '/src/gezels', '/home');
    expect(filter('/src/gezels/ada/about.md')).toBe(true);
    expect(filter('/src/gezels/ada/sessions/x.json')).toBe(true);
    expect(filter('/src/gezels/ada/toolsets')).toBe(false);
    expect(filter('/src/gezels/ada/toolsets/foo')).toBe(false);
    expect(filter('/src/gezels/ada/toolsets.json')).toBe(false);
  });

  it('drops project local-only entries', () => {
    const filter = makeScopeFilter('projects', '/src/projects', '/home');
    expect(filter('/src/projects/foo/artifacts/result.txt')).toBe(true);
    expect(filter('/src/projects/foo/tasks/1/task.json')).toBe(true);
    expect(filter('/src/projects/foo/memories/daily/d.md')).toBe(true);
    expect(filter('/src/projects/foo/documents/about.md')).toBe(true);
    expect(filter('/src/projects/foo/workspace/src.ts')).toBe(false);
    expect(filter('/src/projects/foo/gh/repo')).toBe(false);
    expect(filter('/src/projects/foo/scripts/r.ts')).toBe(false);
    expect(filter('/src/projects/foo/project.json')).toBe(false);
    expect(filter('/src/projects/foo/history.jsonl')).toBe(false);
    expect(filter('/src/projects/foo/questions.json')).toBe(false);
  });
});

describe('planMove', () => {
  it('counts files and bytes for documents', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await writeFile(join(home, 'documents', 'a.md'), 'one');
    await writeFile(join(home, 'documents', 'b.md'), 'two-bytes-here');

    const plan = await planMove({
      home,
      scope: 'documents',
      destPath: join(externalRoot, 'docs'),
      current: undefined,
    });
    expect(plan.files).toBe(2);
    expect(plan.bytes).toBe('one'.length + 'two-bytes-here'.length);
    expect(plan.conflicts).toBe(0);
    expect(plan.validation.ok).toBe(true);
  });

  it('reports conflicts when destination has same-named files', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await writeFile(join(home, 'documents', 'shared.md'), 'src');
    const dest = join(externalRoot, 'docs');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'shared.md'), 'dest');

    const plan = await planMove({
      home,
      scope: 'documents',
      destPath: dest,
      current: undefined,
    });
    expect(plan.files).toBe(1);
    expect(plan.conflicts).toBe(1);
    expect(plan.destNonEmpty).toBe(true);
  });
});

describe('runMove (documents happy path)', () => {
  it('copies, swaps config, cleans up source, and writes a backup', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await writeFile(join(home, 'documents', 'mission.md'), 'do good work');
    await mkdir(join(home, 'documents', 'subdir'), { recursive: true });
    await writeFile(join(home, 'documents', 'subdir', 'note.md'), 'nested');

    const dest = join(externalRoot, 'docs-out');
    const jobs = new JobManager();
    const job = jobs.create({
      scope: 'documents',
      sourcePath: join(home, 'documents'),
      destPath: dest,
      conflictPolicy: 'overwrite-all',
    });
    await runMove({ home, store, jobs, jobId: job.id });

    const after = jobs.get(job.id)!;
    expect(after.status).toBe('done');
    expect(after.restartRequired).toBe(true);

    // Files landed at destination
    expect(await readFile(join(dest, 'mission.md'), 'utf8')).toBe('do good work');
    expect(await readFile(join(dest, 'subdir', 'note.md'), 'utf8')).toBe('nested');

    // Source cleaned up (the documents subtree was removed)
    const sourceEntries = await readdir(join(home, 'documents'));
    expect(sourceEntries).toEqual([]);

    // Backup exists and contains the same files
    const backupRoot = join(home, 'backup');
    const backups = await readdir(backupRoot);
    expect(backups.length).toBe(1);
    const backupContents = await readFile(
      join(backupRoot, backups[0]!, 'documents', 'mission.md'),
      'utf8',
    );
    expect(backupContents).toBe('do good work');

    // Config swap recorded the new external path
    const cfg = await store.readConfig();
    expect(cfg.externalFolders?.documents).toBe(dest);
  });

  it('preserves toolsets/ when externalizing gezels', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    const gezelsRoot = join(home, 'gezels');
    const adaDir = join(gezelsRoot, 'ada');
    await mkdir(adaDir, { recursive: true });
    await writeFile(join(adaDir, 'gezel.md'), 'frontmatter');
    await writeFile(join(adaDir, 'about.md'), 'about ada');
    await mkdir(join(adaDir, 'toolsets'), { recursive: true });
    await writeFile(join(adaDir, 'toolsets', 'pkg.txt'), 'NPM_CONTENT');
    await writeFile(join(adaDir, 'toolsets.json'), '[]');

    const dest = join(externalRoot, 'gezels-out');
    const jobs = new JobManager();
    const job = jobs.create({
      scope: 'gezels',
      sourcePath: gezelsRoot,
      destPath: dest,
      conflictPolicy: 'overwrite-all',
    });
    await runMove({ home, store, jobs, jobId: job.id });

    expect(jobs.get(job.id)!.status).toBe('done');

    // Externalized content
    expect(await readFile(join(dest, 'ada', 'gezel.md'), 'utf8')).toBe('frontmatter');
    expect(await readFile(join(dest, 'ada', 'about.md'), 'utf8')).toBe('about ada');

    // Local toolsets untouched
    expect(await readFile(join(adaDir, 'toolsets', 'pkg.txt'), 'utf8')).toBe('NPM_CONTENT');
    expect(await readFile(join(adaDir, 'toolsets.json'), 'utf8')).toBe('[]');

    // Source's gezel.md/about.md removed
    await expect(stat(join(adaDir, 'gezel.md'))).rejects.toThrow();
    await expect(stat(join(adaDir, 'about.md'))).rejects.toThrow();
  });
});
