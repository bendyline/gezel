import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openIndexDatabase } from './sqlite-driver.js';

function npmLoadablePath(): string | null {
  try {
    return (
      createRequire(import.meta.url)('sqlite-vec') as { getLoadablePath(): string }
    ).getLoadablePath();
  } catch {
    return null;
  }
}

/**
 * Where this host can load sqlite-vec from: an operator-set path (how an
 * extension the native release built gets tested before it ships), else the
 * npm prebuild, else nothing (Windows ARM64 without a native-bin tree).
 */
const hostExtension = process.env.GEZEL_SQLITE_VEC_PATH ?? npmLoadablePath();
const priorPath = process.env.GEZEL_SQLITE_VEC_PATH;

afterEach(() => {
  if (priorPath === undefined) delete process.env.GEZEL_SQLITE_VEC_PATH;
  else process.env.GEZEL_SQLITE_VEC_PATH = priorPath;
});

async function vectorsLoad(): Promise<{ available: boolean; version?: string }> {
  const db = await openIndexDatabase(':memory:');
  if (!db) throw new Error('node:sqlite is unavailable');
  try {
    if (!db.vecAvailable) return { available: false };
    return {
      available: true,
      version: db.prepare('SELECT vec_version() AS v').get<{ v: string }>()?.v,
    };
  } finally {
    db.close();
  }
}

describe('sqlite-vec loading', () => {
  it.skipIf(!hostExtension)('loads the extension GEZEL_SQLITE_VEC_PATH names', async () => {
    process.env.GEZEL_SQLITE_VEC_PATH = hostExtension!;
    const loaded = await vectorsLoad();
    expect(loaded.available).toBe(true);
    expect(loaded.version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('falls back to the npm prebuild when the named path does not load', async () => {
    process.env.GEZEL_SQLITE_VEC_PATH = join(tmpdir(), 'gezel-missing', 'vec0.dll');
    const loaded = await vectorsLoad();
    expect(loaded.available).toBe(npmLoadablePath() !== null);
  });
});
