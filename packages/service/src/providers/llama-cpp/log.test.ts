import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlamaCppLogFile, tailLatestEngineLog } from './log.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('native engine logs', () => {
  it('supports a DS4-specific basename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-ds4-log-'));
    dirs.push(dir);
    const log = new LlamaCppLogFile(dir, 'ds4-server');
    log.write('[ds4-server] started with --ssd-streaming');
    await log.flush();

    expect(log.currentFile()).toMatch(/ds4-server-\d{4}-\d{2}-\d{2}\.log$/);
    expect(await log.tail(4096)).toContain('--ssd-streaming');
    await log.close();
  });

  it('reads the newest retained DS4 log without a live provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-ds4-log-'));
    dirs.push(dir);
    const older = join(dir, 'ds4-server-2026-07-17.log');
    const newer = join(dir, 'ds4-server-2026-07-18.log');
    await writeFile(older, 'old run', 'utf8');
    await writeFile(newer, 'startup\nstreaming enabled\nready', 'utf8');
    const now = new Date();
    await utimes(older, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));

    await expect(tailLatestEngineLog(dir, 'ds4-server', 17)).resolves.toEqual({
      path: newer,
      tail: 'ing enabled\nready',
    });
  });
});
