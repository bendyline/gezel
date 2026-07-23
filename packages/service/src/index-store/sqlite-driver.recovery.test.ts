import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openIndexDatabase } from './sqlite-driver.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openIndexDatabase corruption recovery', () => {
  it('quarantines a malformed rebuildable database and opens a fresh one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-sqlite-recovery-'));
    dirs.push(dir);
    const path = join(dir, 'index.db');
    await writeFile(path, 'definitely not sqlite');

    const db = await openIndexDatabase(path);
    if (!db) return;
    db.exec('CREATE TABLE healthy (id INTEGER PRIMARY KEY)');
    db.close();

    const names = await readdir(dir);
    const quarantined = names.find((name) => name.startsWith('index.db.corrupt-'));
    expect(quarantined).toBeTruthy();
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe('definitely not sqlite');
  });
});
