import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedDaemonLogSink, findTrialNativeChildren } from './spawn.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeChunk(sink: BoundedDaemonLogSink, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sink.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function endSink(sink: BoundedDaemonLogSink): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

describe('bounded eval daemon log', () => {
  it('keeps startup and the live final tail under a hard size ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-eval-log-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    const sink = new BoundedDaemonLogSink(path, {
      maxBytes: 1_024,
      headBytes: 128,
      tailBytes: 256,
    });
    const startup = `SERVICE START ${'s'.repeat(110)}\n`;

    await writeChunk(sink, startup);
    for (let i = 0; i < 80; i += 1) {
      await writeChunk(sink, `spam-${i.toString().padStart(3, '0')} ${'x'.repeat(40)}\n`);
    }
    await writeChunk(sink, 'FINAL native-engine crash signature\n');

    const live = await readFile(path, 'utf8');
    expect((await stat(path)).size).toBeLessThanOrEqual(1_024);
    expect(live).toContain('SERVICE START');
    expect(live).toContain('[eval-log] middle daemon output omitted');
    expect(live).toContain('FINAL native-engine crash signature');
    expect(live).not.toContain('spam-010');
    await endSink(sink);
  });

  it('bounds a single chunk larger than the whole log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-eval-log-'));
    dirs.push(dir);
    const path = join(dir, 'daemon.log');
    const sink = new BoundedDaemonLogSink(path, {
      maxBytes: 512,
      headBytes: 64,
      tailBytes: 128,
    });

    await writeChunk(sink, `BOOT\n${'a'.repeat(2_000)}\nLAST\n`);
    await endSink(sink);

    const text = await readFile(path, 'utf8');
    expect((await stat(path)).size).toBeLessThanOrEqual(512);
    expect(text).toContain('BOOT');
    expect(text).toContain('LAST');
    expect(text).toContain('[eval-log] middle daemon output omitted');
  });
});

describe('eval native-child cleanup', () => {
  it('finds same-home Windows native engines without relying on Unix ps', async () => {
    const home = 'C:\\Users\\Test\\AppData\\Local\\Temp\\gezel-eval-a';
    const listProcesses = vi.fn(async () => [
      {
        pid: 81001,
        ppid: 80000,
        command:
          '"D:\\native\\gezel-llama-server.exe" --model "c:\\users\\test\\appdata\\local\\temp\\gezel-eval-a\\models\\a.gguf"',
      },
      {
        pid: 81002,
        ppid: 80000,
        command:
          'node run.ts --llama-bin D:\\native\\gezel-llama-server.exe --home C:\\Users\\Test\\AppData\\Local\\Temp\\gezel-eval-a',
      },
      {
        pid: 81003,
        ppid: 80000,
        command: '"D:\\native\\gezel-sd-server.exe" --model "C:\\other-eval\\models\\sd.gguf"',
      },
    ]);

    await expect(
      findTrialNativeChildren(home, {
        platform: 'win32',
        listProcesses,
      }),
    ).resolves.toEqual([81001]);
    expect(listProcesses).toHaveBeenCalledWith({ platform: 'win32' });
  });

  it('fails closed with an empty target list when process discovery is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        findTrialNativeChildren('/tmp/gezel-eval', {
          platform: 'linux',
          listProcesses: async () => {
            throw new Error('process table denied');
          },
        }),
      ).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('process snapshot failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
