import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepCodexHomes } from './runtime-sweep.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-codex-sweep-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeHome(project: string, session: string, ageMs: number): Promise<void> {
  const home = join(dir, project, session);
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'config.toml'), 'model = "gpt-5.5"\n');
  const at = new Date(NOW - ageMs);
  await utimes(home, at, at);
}

async function sessionsIn(project: string): Promise<string[]> {
  return (await readdir(join(dir, project))).sort();
}

describe('sweepCodexHomes', () => {
  it('removes homes idle past the age limit and keeps recent ones', async () => {
    await makeHome('proj-a', 'fresh', 2 * HOUR_MS);
    await makeHome('proj-a', 'stale', 20 * 24 * HOUR_MS);
    await makeHome('oneshot', 'oneshot-old', 15 * 24 * HOUR_MS);

    const result = await sweepCodexHomes({ runtimeDir: dir, now: NOW });

    expect(result).toEqual({ scanned: 3, removed: 2 });
    expect(await sessionsIn('proj-a')).toEqual(['fresh']);
    expect(await sessionsIn('oneshot')).toEqual([]);
  });

  it('keeps only the newest homes past the count limit, across projects', async () => {
    await makeHome('proj-a', 's1', 2 * HOUR_MS);
    await makeHome('proj-b', 's2', 3 * HOUR_MS);
    await makeHome('proj-a', 's3', 4 * HOUR_MS);
    await makeHome('proj-b', 's4', 5 * HOUR_MS);

    const result = await sweepCodexHomes({ runtimeDir: dir, now: NOW, maxHomes: 2 });

    expect(result).toEqual({ scanned: 4, removed: 2 });
    expect(await sessionsIn('proj-a')).toEqual(['s1']);
    expect(await sessionsIn('proj-b')).toEqual(['s2']);
  });

  it('never removes a home used within the minimum age, even over the count limit', async () => {
    await makeHome('proj-a', 'in-flight-1', 10 * 60 * 1000);
    await makeHome('proj-a', 'in-flight-2', 20 * 60 * 1000);
    await makeHome('proj-a', 'done', 3 * HOUR_MS);

    const result = await sweepCodexHomes({ runtimeDir: dir, now: NOW, maxHomes: 1 });

    expect(result).toEqual({ scanned: 3, removed: 1 });
    expect(await sessionsIn('proj-a')).toEqual(['in-flight-1', 'in-flight-2']);
  });

  it('ignores stray files and tolerates a missing runtime directory', async () => {
    await mkdir(join(dir, 'proj-a'), { recursive: true });
    await writeFile(join(dir, 'proj-a', 'notes.txt'), 'not a home');
    await writeFile(join(dir, 'stray.json'), '{}');

    expect(await sweepCodexHomes({ runtimeDir: dir, now: NOW, maxHomes: 0 })).toEqual({
      scanned: 0,
      removed: 0,
    });
    expect(await sessionsIn('proj-a')).toEqual(['notes.txt']);
    expect(await sweepCodexHomes({ runtimeDir: join(dir, 'missing'), now: NOW })).toEqual({
      scanned: 0,
      removed: 0,
    });
  });
});
