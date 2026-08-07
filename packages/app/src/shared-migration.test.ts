import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MACHINE_SHARED_MARKER, migrateLegacyMachineDataToShared } from './shared-migration.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-shared-migration-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('migrateLegacyMachineDataToShared', () => {
  it('ships the migration CLI as a real unpacked installer resource', async () => {
    const appRoot = new URL('../', import.meta.url);
    const [builder, tsup] = await Promise.all([
      readFile(new URL('electron-builder.yml', appRoot), 'utf8'),
      readFile(new URL('tsup.config.ts', appRoot), 'utf8'),
    ]);
    expect(tsup).toContain("'migrate-legacy-shared': 'src/migrate-legacy-shared.ts'");
    expect(builder.match(/- dist\/migrate-legacy-shared\.js/g)).toHaveLength(2);
  });

  it('moves projects and gezels, preserves bytes, and publishes the marker last', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    await mkdir(join(source, 'projects', 'old-project', 'workspace'), { recursive: true });
    await writeFile(join(source, 'projects', 'old-project', 'project.json'), '{"id":"old"}\n');
    await writeFile(
      join(source, 'projects', 'old-project', 'workspace', 'note.txt'),
      'machine project bytes\n',
    );
    await mkdir(join(source, 'gezels', 'ada', 'sessions'), { recursive: true });
    await writeFile(join(source, 'gezels', 'ada', 'gezel.md'), '---\nid: ada\nname: Ada\n---\n');
    await writeFile(join(source, 'gezels', 'ada', 'sessions', 's1.json'), '{"id":"s1"}\n');

    const result = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });

    expect(result.moved).toEqual({ projects: 1, gezels: 1 });
    expect(
      await readFile(join(shared, 'projects', 'old-project', 'workspace', 'note.txt'), 'utf8'),
    ).toBe('machine project bytes\n');
    expect(await readFile(join(shared, 'gezels', 'ada', 'sessions', 's1.json'), 'utf8')).toBe(
      '{"id":"s1"}\n',
    );
    await expect(stat(join(source, 'projects', 'old-project'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const marker = JSON.parse(await readFile(join(shared, MACHINE_SHARED_MARKER), 'utf8'));
    expect(marker).toMatchObject({
      version: 1,
      privateStatePolicy: 'copy-legacy-gezel-runtime-per-user-on-first-mount',
    });
  });

  it('is idempotent after a completed migration', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    await mkdir(join(source, 'projects', 'one'), { recursive: true });
    await writeFile(join(source, 'projects', 'one', 'project.json'), '{}');
    await migrateLegacyMachineDataToShared({ sourceHome: source, sharedHome: shared });
    const second = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });
    expect(second.moved).toEqual({ projects: 0, gezels: 0 });
    expect(await readFile(join(shared, 'projects', 'one', 'project.json'), 'utf8')).toBe('{}');
  });

  it('never overwrites a conflicting destination — it sets the legacy copy aside', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    await mkdir(join(source, 'projects', 'same'), { recursive: true });
    await mkdir(join(shared, 'projects', 'same'), { recursive: true });
    await writeFile(join(source, 'projects', 'same', 'project.json'), 'source');
    await writeFile(join(shared, 'projects', 'same', 'project.json'), 'destination');

    // Previously this threw, which aborted the installer's machine-service
    // step entirely (and on macOS the whole package install). The
    // never-overwrite guarantee is unchanged; only the blast radius is.
    const result = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });
    expect(result.quarantined.projects).toBe(1);

    // The shared copy is authoritative and untouched.
    expect(await readFile(join(shared, 'projects', 'same', 'project.json'), 'utf8')).toBe(
      'destination',
    );
    // The legacy bytes still exist — moved aside, not deleted.
    const held = join(source, '.gezel-migration-quarantine', 'projects');
    const [dir] = await readdir(held);
    if (!dir) throw new Error('expected the conflicting project to be quarantined');
    expect(dir).toMatch(/^same-/);
    expect(await readFile(join(held, dir, 'project.json'), 'utf8')).toBe('source');
    // And it is not left where a later run would re-enumerate it as an entity.
    await expect(stat(join(source, 'projects', 'same'))).rejects.toThrow();
  });

  // The shape that actually blocked v1.26219.45. A machine-engine broker
  // recreated `projects/default` under its own home as a near-empty stub while
  // the real project lived in `shared/`. Byte-equality could never hold, so
  // every upgrade failed — permanently, because the stub returned on each boot.
  it('drops a legacy copy that is a strict subset of the shared copy', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    // Daemon-created stub: one directory, nothing unique.
    await mkdir(join(source, 'projects', 'default', 'memories'), { recursive: true });
    // The real project.
    await mkdir(join(shared, 'projects', 'default', 'memories'), { recursive: true });
    await mkdir(join(shared, 'projects', 'default', 'tasks', '1'), { recursive: true });
    await writeFile(join(shared, 'projects', 'default', 'project.json'), '{"id":"default"}');
    await writeFile(join(shared, 'projects', 'default', 'tasks', '1', 'task.json'), '{}');

    const result = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });
    expect(result.quarantined.projects).toBe(0);
    expect(result.recovered.projects).toBe(1);

    // Real data intact, stub gone, nothing parked in quarantine.
    expect(await readFile(join(shared, 'projects', 'default', 'project.json'), 'utf8')).toBe(
      '{"id":"default"}',
    );
    await expect(stat(join(source, 'projects', 'default'))).rejects.toThrow();
    await expect(stat(join(source, '.gezel-migration-quarantine'))).rejects.toThrow();
  });

  it('keeps a legacy-only entity that the shared copy never had', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    // `gezels/ilse` on the audited machine: created by the broker, absent from
    // shared. It must migrate normally rather than be dropped or quarantined.
    await mkdir(join(source, 'gezels', 'ilse'), { recursive: true });
    await writeFile(join(source, 'gezels', 'ilse', 'gezel.md'), 'id: ilse');
    await mkdir(join(shared, 'gezels', 'rasmus'), { recursive: true });
    await writeFile(join(shared, 'gezels', 'rasmus', 'gezel.md'), 'id: rasmus');

    const result = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });
    expect(result.moved.gezels).toBe(1);
    expect(result.quarantined.gezels).toBe(0);
    expect(await readFile(join(shared, 'gezels', 'ilse', 'gezel.md'), 'utf8')).toBe('id: ilse');
    expect(await readFile(join(shared, 'gezels', 'rasmus', 'gezel.md'), 'utf8')).toBe('id: rasmus');
  });
  // Observed during the real repair: every adopted gezel differed from its
  // shared original by exactly one file — the adoption marker the daemon
  // writes. Quarantining on that alone would leave a dated copy of already-safe
  // data behind for every affected install.
  it('ignores Gezel-generated markers when deciding a legacy copy is unique', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    await mkdir(join(source, 'gezels', 'rasmus'), { recursive: true });
    await writeFile(join(source, 'gezels', 'rasmus', 'gezel.md'), 'id: rasmus');
    await writeFile(
      join(source, 'gezels', 'rasmus', '.machine-shared-import-v1.json'),
      '{"importedAt":"..."}',
    );
    await mkdir(join(shared, 'gezels', 'rasmus'), { recursive: true });
    await writeFile(join(shared, 'gezels', 'rasmus', 'gezel.md'), 'id: rasmus');

    const result = await migrateLegacyMachineDataToShared({
      sourceHome: source,
      sharedHome: shared,
    });
    expect(result.quarantined.gezels).toBe(0);
    expect(result.recovered.gezels).toBe(1);
    await expect(stat(join(source, '.gezel-migration-quarantine'))).rejects.toThrow();
    expect(await readFile(join(shared, 'gezels', 'rasmus', 'gezel.md'), 'utf8')).toBe('id: rasmus');
  });
});
