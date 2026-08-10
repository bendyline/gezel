import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlamaCppLogFile, LlamaProgressLogThrottle, tailLatestEngineLog } from './log.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('native engine logs', () => {
  it('throttles semantic duplicates of stuck llama prompt progress', () => {
    let now = 1_000;
    const throttle = new LlamaProgressLogThrottle(5_000, () => now);
    const line = (uptime: string, tokens = 2048, progress = '3.02') =>
      `[llama-server] ${uptime} I slot print_timing: id  0 | task 13787 | prompt processing, n_tokens = ${tokens}, progress = ${progress}, t = 630.23 s / 3.25 tokens per second`;

    expect(throttle.accept(line('13.44.290.696'))).toEqual([line('13.44.290.696')]);
    expect(throttle.accept(line('13.44.290.738'))).toEqual([]);
    expect(throttle.accept(line('13.44.290.778'))).toEqual([]);

    now += 5_000;
    expect(throttle.accept(line('13.49.290.696'))).toEqual([
      '[llama-server] suppressed 2 duplicate prompt-progress log lines with no token/progress change',
      line('13.49.290.696'),
    ]);

    // A changed token/progress state is real activity and never waits for the
    // throttle interval.
    expect(throttle.accept(line('13.49.300.000', 4096, '0.50'))).toEqual([
      line('13.49.300.000', 4096, '0.50'),
    ]);
  });

  it('flushes the duplicate count before a non-progress diagnostic', () => {
    const throttle = new LlamaProgressLogThrottle(5_000, () => 1_000);
    const progress =
      '[llama-server] 1.0 I slot print_timing: id 0 | task 7 | prompt processing, n_tokens = 2048, progress = 3.02';
    expect(throttle.accept(progress)).toEqual([progress]);
    expect(throttle.accept(progress)).toEqual([]);

    expect(throttle.accept('[llama-server] CUDA error: out of memory')).toEqual([
      '[llama-server] suppressed 1 duplicate prompt-progress log lines with no token/progress change',
      '[llama-server] CUDA error: out of memory',
    ]);
  });

  it('persists a redacted structured crash without the stdout tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-llama-log-'));
    dirs.push(dir);
    const log = new LlamaCppLogFile(dir);
    log.writeIncident({
      incidentId: 'native-55121-1234',
      pid: 55121,
      startedAt: 1000,
      exitedAt: 1234,
      uptimeMs: 234,
      code: null,
      signal: 'SIGABRT',
      expected: false,
      reachedReady: true,
      panicKind: 'cuda-invalid-argument',
      panicLine: 'CUDA error: invalid argument token=sk-abcdefghijklmnopqrstuvwxyz123456',
      outputTail: 'user prompt that must not be persisted',
    });

    const raw = await readFile(join(dir, 'native-incidents.jsonl'), 'utf8');
    const incident = JSON.parse(raw) as Record<string, unknown>;
    expect(incident).toMatchObject({
      incidentId: 'native-55121-1234',
      panicKind: 'cuda-invalid-argument',
    });
    expect(raw).not.toContain('user prompt');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    await log.close();
  });

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
