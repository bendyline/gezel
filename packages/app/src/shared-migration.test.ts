import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('refuses a conflicting destination instead of overwriting it', async () => {
    const source = join(root, 'machine');
    const shared = join(root, 'shared');
    await mkdir(join(source, 'projects', 'same'), { recursive: true });
    await mkdir(join(shared, 'projects', 'same'), { recursive: true });
    await writeFile(join(source, 'projects', 'same', 'project.json'), 'source');
    await writeFile(join(shared, 'projects', 'same', 'project.json'), 'destination');

    await expect(
      migrateLegacyMachineDataToShared({ sourceHome: source, sharedHome: shared }),
    ).rejects.toThrow(/source and destination differ/);
    expect(await readFile(join(source, 'projects', 'same', 'project.json'), 'utf8')).toBe('source');
    expect(await readFile(join(shared, 'projects', 'same', 'project.json'), 'utf8')).toBe(
      'destination',
    );
  });
});
