import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTransientIndexError,
  isUnavailableIndexError,
  openIndexDatabase,
  retryOnContention,
} from './sqlite-driver.js';

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

describe('SQLite contention without blocking the API loop', () => {
  it('recognizes native and extended lock errors without treating them as unavailable storage', () => {
    for (const error of [
      new Error('database is locked'),
      new Error('database table is locked'),
      Object.assign(new Error('opaque native failure'), { errcode: 5 }),
      Object.assign(new Error('opaque native failure'), { errcode: 6 }),
      Object.assign(new Error('opaque native failure'), { errcode: 517 }),
    ]) {
      expect(isTransientIndexError(error)).toBe(true);
      expect(isUnavailableIndexError(error)).toBe(false);
    }
    expect(isTransientIndexError(Object.assign(new Error('disk I/O error'), { errcode: 10 }))).toBe(
      false,
    );
    expect(isTransientIndexError(new Error('file is not a database'))).toBe(false);
  });

  it('bounds a real main-thread lock wait and writes successfully after release', async () => {
    expect(isMainThread).toBe(true); // This suite runs in the forks pool.
    const dir = await mkdtemp(join(tmpdir(), 'gezel-sqlite-busy-'));
    dirs.push(dir);
    const writer = await openIndexDatabase(join(dir, 'index.db'));
    expect(writer).not.toBeNull();
    writer!.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    const reader = await openIndexDatabase(join(dir, 'index.db'));
    expect(reader).not.toBeNull();
    try {
      expect(reader!.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 25 });
      writer!.exec('BEGIN IMMEDIATE');
      const start = performance.now();
      let failure: unknown;
      try {
        reader!.exec('INSERT INTO sample VALUES (1)');
      } catch (error) {
        failure = error;
      }
      expect(isTransientIndexError(failure)).toBe(true);
      expect(performance.now() - start).toBeLessThan(1_000);
      writer!.exec('COMMIT');
      reader!.exec('INSERT INTO sample VALUES (1)');
      expect(reader!.prepare('SELECT count(*) AS n FROM sample').get()).toEqual({ n: 1 });
    } finally {
      reader!.close();
      writer!.close();
    }
  });

  it('lands an expensive write once a longer lock is released, without blocking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-sqlite-retry-'));
    dirs.push(dir);
    const writer = await openIndexDatabase(join(dir, 'index.db'));
    writer!.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    const other = await openIndexDatabase(join(dir, 'index.db'));
    try {
      // Held well past the 25 ms busy budget, as a static-index pass does.
      writer!.exec('BEGIN IMMEDIATE');
      let released = false;
      setTimeout(() => {
        writer!.exec('COMMIT');
        released = true;
      }, 300);
      await retryOnContention(() => other!.exec('INSERT INTO sample VALUES (7)'));
      expect(released).toBe(true);
      expect(other!.prepare('SELECT id FROM sample').get()).toEqual({ id: 7 });
    } finally {
      other!.close();
      writer!.close();
    }
  });

  it('gives up on contention after its budget and never retries other errors', async () => {
    let calls = 0;
    const busy = Object.assign(new Error('opaque native failure'), { errcode: 5 });
    await expect(
      retryOnContention(
        () => {
          calls++;
          throw busy;
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toBe(busy);
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      retryOnContention(() => {
        calls++;
        throw new Error('file is not a database');
      }),
    ).rejects.toThrow('file is not a database');
    expect(calls).toBe(1);
  });
});
