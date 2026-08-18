import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  STORAGE_CATEGORIES,
  classifiedTopLevelNames,
  ephemeralPaths,
  isPathInside,
} from './registry.js';
import { buildStorageSummary, invalidateStorageSummary } from './summary.js';

let home: string;
let elsewhere: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-storage-'));
  elsewhere = await mkdtemp(join(tmpdir(), 'gezel-outside-'));
  invalidateStorageSummary();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

async function seedFile(path: string, sizeBytes: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x'.repeat(sizeBytes));
}

async function summarize(store: Store) {
  invalidateStorageSummary();
  return buildStorageSummary({ home, store }, true);
}

/** First path segment under the home directory, or null when outside it. */
function topLevelName(path: string, root: string): string | null {
  if (!isPathInside(path, root)) return null;
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(sep)[0] ?? null;
}

function category(summary: Awaited<ReturnType<typeof summarize>>, id: string) {
  const found = summary.categories.find((c) => c.id === id);
  if (!found) throw new Error(`category ${id} missing from summary`);
  return found;
}

describe('storage registry', () => {
  it('classifies every category into exactly one class', () => {
    const ids = STORAGE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of STORAGE_CATEGORIES) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('never marks uninstaller-owned trees deletable', () => {
    // The daemon executes out of the extracted bundle and the pinned node
    // runtime. Offering to delete them would have it saw off its own branch.
    for (const def of STORAGE_CATEGORIES) {
      if (def.class === 'uninstaller-owned') expect(def.deletable).toBe(false);
    }
  });

  it('keeps secrets out of backups', () => {
    const secrets = STORAGE_CATEGORIES.find((c) => c.id === 'secrets');
    expect(secrets?.inBackup).toBe(false);
  });

  it('holds git clones back from cleanup', () => {
    // Working copies outside the home directory reference these clones.
    const clones = STORAGE_CATEGORIES.find((c) => c.id === 'git-clones');
    expect(clones?.deletable).toBe(false);
  });
});

describe('isPathInside', () => {
  it('accepts the home directory and its descendants', () => {
    expect(isPathInside(home, home)).toBe(true);
    expect(isPathInside(join(home, 'gezels', 'a'), home)).toBe(true);
  });

  it('rejects siblings that merely share a name prefix', () => {
    expect(isPathInside(`${home}-other`, home)).toBe(false);
    expect(isPathInside(elsewhere, home)).toBe(false);
  });
});

describe('storage summary', () => {
  it('accounts for downloaded models as re-downloadable', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await seedFile(join(home, 'engines', 'llama-cpp', 'models', 'demo-7b', 'weights.gguf'), 4096);
    await seedFile(join(home, 'engines', 'llama-cpp', 'models', 'demo-7b', 'manifest.json'), 32);

    const summary = await summarize(store);
    const models = category(summary, 'models');
    expect(models.class).toBe('redownloadable');
    expect(models.bytes).toBe(4128);
    expect(models.items?.map((i) => i.id)).toEqual(['llama-cpp/demo-7b']);
    expect(summary.redownloadableBytes).toBeGreaterThanOrEqual(4128);
  });

  it('counts a project once even though several helpers name its directory', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Roof Survey' });

    const before = await summarize(store);
    const beforeBytes =
      category(before, 'projects').items?.find((i) => i.id === project.id)?.bytes ?? 0;

    await seedFile(join(home, 'projects', project.id, 'workspace', 'notes.md'), 1000);

    const after = await summarize(store);
    const afterBytes =
      category(after, 'projects').items?.find((i) => i.id === project.id)?.bytes ?? 0;

    // Exactly the bytes written. projectDir, projectStorageDir, and
    // projectPrivateDir all resolve to this directory on a default install,
    // so a naive sum would report the file two or three times over.
    expect(afterBytes - beforeBytes).toBe(1000);
  });

  it('excludes a project’s generated index from its user-content size', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Indexed' });
    await seedFile(join(home, 'projects', project.id, 'workspace', 'doc.md'), 500);

    const before = await summarize(store);
    const beforeBytes = category(before, 'projects').bytes;

    // The content index lives inside the project directory but belongs to
    // derived-caches; growing it must not grow "your content".
    await seedFile(join(home, 'projects', project.id, '_index', 'content.db'), 50_000);

    const after = await summarize(store);
    expect(category(after, 'projects').bytes).toBe(beforeBytes);
    expect(category(after, 'derived-caches').bytes).toBeGreaterThanOrEqual(50_000);
  });

  it('flags an externalized gezels folder instead of counting it as deletable', async () => {
    const externalGezels = join(elsewhere, 'my-gezels');
    await mkdir(externalGezels, { recursive: true });
    const store = new Store({ home, external: { gezels: externalGezels } });
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Wander' });
    await seedFile(join(externalGezels, gezel.id, 'big.md'), 2048);

    const summary = await summarize(store);
    const gezels = category(summary, 'gezels');
    const item = gezels.items?.find((i) => i.id === gezel.id);
    expect(item?.external).toBe(true);
    expect(gezels.external.some((e) => e.path.startsWith(externalGezels))).toBe(true);
  });

  it('never reports a project working directory as safe to remove', async () => {
    const workingDir = join(elsewhere, 'repo');
    await mkdir(workingDir, { recursive: true });
    await seedFile(join(workingDir, 'README.md'), 300);
    const store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Linked', workingDir });

    const summary = await summarize(store);
    const entry = category(summary, 'projects').items?.find(
      (i) => i.id === `${project.id}:workingDir`,
    );
    expect(entry).toBeDefined();
    expect(entry?.external).toBe(true);
    expect(entry?.blockedReason).toBeTruthy();
  });

  it('leaves the document library out of the projects category', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await store.readConfig();

    const summary = await summarize(store);
    const projects = category(summary, 'projects');
    const shared = (await store.listProjects()).find(
      (p) => p.properties?.['gezel.sharedLibrary'] === '1',
    );
    if (!shared) return; // No shared library on this layout; nothing to guard.
    expect(projects.items?.some((i) => i.id === shared.id)).toBe(false);
    expect(category(summary, 'documents').bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('classification coverage', () => {
  it('declares every top-level path the categories actually resolve', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Coverage' });
    await store.createProject({ name: 'Coverage' });

    const ctx = { home, store, env: process.env };
    const resolved = new Set<string>();
    for (const def of STORAGE_CATEGORIES) {
      for (const entry of await def.resolve(ctx)) {
        const name = topLevelName(entry.path, home);
        if (name) resolved.add(name);
      }
    }
    for (const path of ephemeralPaths(home)) {
      const name = topLevelName(path, home);
      if (name) resolved.add(name);
    }

    // classifiedTopLevelNames() is what the cleanup UI and the docs describe
    // as covered. A category that resolves somewhere absent from that list
    // means the description and the behavior have drifted apart.
    const declared = new Set(classifiedTopLevelNames());
    const undeclared = [...resolved].filter((name) => !declared.has(name)).sort();
    expect(undeclared).toEqual([]);
  });

  it('claims every top-level entry a populated home directory grows', async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Coverage' });
    await store.createProject({ name: 'Coverage' });
    // Trees whose owning managers create them lazily, outside this fixture.
    for (const dir of ['engines', 'bin', 'service', 'index', 'gilde', 'system-toolsets']) {
      await mkdir(join(home, dir), { recursive: true });
    }

    const { readdir } = await import('node:fs/promises');
    const present = await readdir(home);
    expect(present.length).toBeGreaterThan(5);
    const known = new Set(classifiedTopLevelNames());
    const unclassified = present.filter((name) => !known.has(name));

    // A new top-level directory that no category claims escapes both cleanup
    // and backup silently. Add it to a category (or to the ephemeral list)
    // rather than widening this expectation.
    expect(unclassified).toEqual([]);
  });

  it('resolves paths outside the home directory to no top-level name', () => {
    expect(topLevelName(join(elsewhere, 'repo'), home)).toBeNull();
  });

  it('treats runtime handshake state and journals as ephemeral', () => {
    const paths = ephemeralPaths(home);
    expect(paths).toContain(join(home, 'runtime'));
    expect(paths).toContain(join(home, '.transactions'));
    expect(paths).toContain(join(home, 'logs'));
  });
});
