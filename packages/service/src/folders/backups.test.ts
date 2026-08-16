import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotCreatedAt, summarizeBackups } from './backups.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-backups-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedSnapshot(id: string, scope: string, files: Record<string, string>) {
  const dir = join(home, 'backup', id, scope);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
}

describe('snapshotCreatedAt', () => {
  it('reverses the move worker’s filename sanitization', () => {
    const iso = new Date('2026-08-15T12:30:45.123Z').toISOString();
    const id = iso.replace(/[:.]/g, '-');
    expect(snapshotCreatedAt(id)).toBe(iso);
  });

  it('returns null for a name that is not a timestamp', () => {
    expect(snapshotCreatedAt('my-manual-copy')).toBeNull();
  });
});

describe('summarizeBackups', () => {
  it('reports zero when no move has ever run', async () => {
    const summary = await summarizeBackups(home);
    expect(summary.count).toBe(0);
    expect(summary.totalBytes).toBe(0);
    expect(summary.snapshots).toEqual([]);
    expect(summary.path).toBe(join(home, 'backup'));
  });

  it('lists snapshots newest first with scope, size, and timestamp', async () => {
    await seedSnapshot('2026-08-01T10-00-00-000Z', 'documents', { 'a.md': 'aa' });
    await seedSnapshot('2026-08-14T09-15-00-000Z', 'gezels', { 'b.md': 'bbbb' });

    const summary = await summarizeBackups(home);

    expect(summary.count).toBe(2);
    expect(summary.totalBytes).toBe(6);
    expect(summary.snapshots.map((s) => s.id)).toEqual([
      '2026-08-14T09-15-00-000Z',
      '2026-08-01T10-00-00-000Z',
    ]);
    expect(summary.snapshots[0]).toMatchObject({
      scopes: ['gezels'],
      bytes: 4,
      createdAt: '2026-08-14T09:15:00.000Z',
      path: join(home, 'backup', '2026-08-14T09-15-00-000Z'),
    });
  });

  it('counts nested files and keeps unparseable folder names', async () => {
    await seedSnapshot('manual-copy', 'projects', {});
    await mkdir(join(home, 'backup', 'manual-copy', 'projects', 'deep'), { recursive: true });
    await writeFile(join(home, 'backup', 'manual-copy', 'projects', 'deep', 'c.md'), 'ccc', 'utf8');
    await writeFile(join(home, 'backup', 'stray-file.txt'), 'x', 'utf8');

    const summary = await summarizeBackups(home);

    expect(summary.count).toBe(1);
    expect(summary.snapshots[0]).toMatchObject({
      id: 'manual-copy',
      scopes: ['projects'],
      bytes: 3,
      createdAt: null,
    });
  });
});
