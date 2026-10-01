import { describe, expect, it } from 'vitest';
import { isSharedLibraryProject } from '../shared-project.js';
import { PortableStore } from './store.js';
import { MemoryFiles } from './test-files.js';
import { createTieredFileSystem } from './tiered-files.js';

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
const bytes = (value: string) => new TextEncoder().encode(value);

function tiered() {
  const work = new MemoryFiles();
  const device = new MemoryFiles();
  return { work, device, files: createTieredFileSystem({ work, device }) };
}

describe('tiered product files', () => {
  it('routes each path to its tier and merges a directory both tiers hold', async () => {
    const { work, device, files } = tiered();
    await files.mkdir('projects/p/artifacts/shadow');
    await files.write('projects/p/artifacts/report.md', bytes('# Report'));
    await files.write('projects/p/artifacts/shadow/report.md', bytes('cache'));
    await files.write('config.json', bytes('{}'));
    expect(text(await work.read('projects/p/artifacts/report.md'))).toBe('# Report');
    expect(text(await device.read('projects/p/artifacts/shadow/report.md'))).toBe('cache');
    expect(await work.read('config.json')).toBeNull();
    const names = (await files.list('projects/p/artifacts')).map((entry) => entry.name).sort();
    expect(names).toEqual(['report.md', 'shadow']);
    expect((await files.list('')).map((entry) => entry.name).sort()).toEqual([
      'config.json',
      'projects',
    ]);
    await expect(files.list('projects/missing')).rejects.toThrow();
  });

  it('renames and removes across both tiers', async () => {
    const { work, device, files } = tiered();
    await files.mkdir('projects/a/artifacts/shadow');
    await files.write('projects/a/project.json', bytes('{}'));
    await files.write('projects/a/artifacts/shadow/x.md', bytes('cache'));
    await files.rename('projects/a', 'projects/b');
    expect(text(await work.read('projects/b/project.json'))).toBe('{}');
    expect(text(await device.read('projects/b/artifacts/shadow/x.md'))).toBe('cache');
    expect(await files.read('projects/a/project.json')).toBeNull();
    await expect(files.rename('projects/b', 'projects/b')).rejects.toThrow();
    await files.remove('projects/b');
    await expect(files.list('projects/b')).rejects.toThrow();
  });

  it('gives a fresh install back its crew and projects from an existing Gezel folder', async () => {
    const { work, files } = tiered();
    let id = 0;
    const options = { createId: () => `id-${++id}`, now: () => '2026-10-01T12:00:00Z' };
    const first = new PortableStore({ ...options, files });
    await first.ensureLayout();
    const meester = (await first.readConfig()).meesterGezelId;
    const helper = await first.createGezel({ name: 'Helper', role: 'Researcher' });
    const project = await first.createProject({ name: 'Garden' });
    expect(await work.read('config.json')).toBeNull();

    // Uninstall and reinstall: the device root is new, the Gezel folder is not.
    const restored = new PortableStore({
      ...options,
      files: createTieredFileSystem({ work, device: new MemoryFiles() }),
    });
    await restored.ensureLayout();
    expect((await restored.listGezels()).map((gezel) => gezel.id).sort()).toEqual(
      [meester, helper.id].sort(),
    );
    expect((await restored.readConfig()).meesterGezelId).toBeTruthy();
    expect((await restored.listProjects()).map((p) => p.id)).toContain(project.id);
    const libraries = (await restored.listProjects()).filter(isSharedLibraryProject);
    expect(libraries).toHaveLength(1);
    expect((await restored.readConfig()).sharedProjectId).toBe(libraries[0]!.id);
  });
});
