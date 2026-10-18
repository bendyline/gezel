import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAvailableLlamaBinary } from './llama-backend.js';
import type { LlamaQuarantineEntry, QuarantineIo } from './llama-quarantine.js';
import {
  LLAMA_QUARANTINE_STRIKES,
  binaryFingerprint,
  clearLlamaQuarantine,
  clearLlamaStartupStrikes,
  isBinaryQuarantined,
  llamaQuarantinePath,
  readLlamaQuarantine,
  readLlamaQuarantineStrikes,
  recordLlamaQuarantine,
  recordLlamaStartupCrash,
} from './llama-quarantine.js';

const dirs: string[] = [];
const memoryHome = join(tmpdir(), 'gezel-quarantine-memory');
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-quarantine-'));
  dirs.push(dir);
  return dir;
}

/** In-memory fs + a stat table keyed by path, so tests control fingerprints. */
function fakeIo(stats: Record<string, { size: number; mtimeMs: number }>): QuarantineIo & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => {
      const value = files.get(p);
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    },
    writeFile: (p, data) => void files.set(p, data),
    statFile: (p) => {
      const info = stats[p];
      if (!info) throw new Error(`ENOENT ${p}`);
      return info;
    },
    mkdir: () => {},
    now: () => new Date('2026-07-31T18:32:00.000Z'),
  };
}

describe('llama quarantine', () => {
  it('records a crashed backend and matches it back by binary identity', () => {
    const bin = '/opt/Gezel/native-bin/linux-x64-cuda/gezel-llama-server';
    const io = fakeIo({ [bin]: { size: 14600, mtimeMs: 1_785_547_847_453 } });

    const entry = recordLlamaQuarantine(
      memoryHome,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'crashed before ready' },
      io,
    );

    expect(entry).toMatchObject({ backend: 'cuda', signal: 'SIGILL' });
    expect(entry?.fingerprint).toBe('14600:1785547847453');
    expect(isBinaryQuarantined(readLlamaQuarantine(memoryHome, io), 'cuda', bin, io)).toBe(true);
  });

  it('expires the entry when the binary is replaced, so a fixed build is retried', () => {
    const bin = '/opt/Gezel/native-bin/linux-x64-cuda/gezel-llama-server';
    const io = fakeIo({ [bin]: { size: 14600, mtimeMs: 1_785_547_847_453 } });
    recordLlamaQuarantine(
      memoryHome,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'crashed before ready' },
      io,
    );

    // A native release replaces the binary in place. This is the case a
    // version-keyed quarantine gets wrong: the SIGILL fix that motivated
    // this file was a compiler-flag change at an unchanged llama.cpp pin.
    const upgraded = fakeIo({ [bin]: { size: 21344, mtimeMs: 1_785_999_999_999 } });
    upgraded.files.set(
      llamaQuarantinePath(memoryHome),
      io.files.get(llamaQuarantinePath(memoryHome)) ?? '',
    );

    expect(
      isBinaryQuarantined(readLlamaQuarantine(memoryHome, upgraded), 'cuda', bin, upgraded),
    ).toBe(false);
  });

  it('replaces rather than appends when the same backend crashes again', () => {
    const bin = '/bin/llama';
    const io = fakeIo({ [bin]: { size: 10, mtimeMs: 1 } });
    recordLlamaQuarantine(
      memoryHome,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'a' },
      io,
    );
    recordLlamaQuarantine(
      memoryHome,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'b' },
      io,
    );

    const entries = readLlamaQuarantine(memoryHome, io);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('b');
  });

  it('returns null when the binary cannot be fingerprinted', () => {
    const io = fakeIo({});
    expect(
      recordLlamaQuarantine(
        memoryHome,
        { backend: 'cuda', binaryPath: '/gone', signal: 'SIGILL', reason: 'x' },
        io,
      ),
    ).toBeNull();
  });

  it('treats a missing or malformed file as no quarantine', () => {
    const io = fakeIo({});
    expect(readLlamaQuarantine(memoryHome, io)).toEqual([]);
    io.files.set(llamaQuarantinePath(memoryHome), '{ not json');
    expect(readLlamaQuarantine(memoryHome, io)).toEqual([]);
    io.files.set(
      llamaQuarantinePath(memoryHome),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
    );
    expect(readLlamaQuarantine(memoryHome, io)).toEqual([]);
  });

  it('fingerprints a real file on disk', async () => {
    const home = await tmpHome();
    const path = join(home, 'probe.bin');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'abc');
    expect(binaryFingerprint(path)).toMatch(/^3:\d+$/);
    expect(binaryFingerprint(join(home, 'absent'))).toBeNull();
  });
});

describe('startup-crash strikes', () => {
  const bin = 'C:/Gezel/native/win32-x64-vulkan/gezel-llama-server.exe';
  const crash = {
    backend: 'vulkan' as const,
    binaryPath: bin,
    signal: 'exit:0xc0000005',
    reason: 'access violation before ready',
  };
  const stat = { [bin]: { size: 25888, mtimeMs: 1_792_000_000_000 } };

  it('quarantines only the third crash in a row', () => {
    const io = fakeIo(stat);
    expect(LLAMA_QUARANTINE_STRIKES).toBe(3);
    expect(recordLlamaStartupCrash(memoryHome, crash, io)).toEqual({ strikes: 1, entry: null });
    expect(recordLlamaStartupCrash(memoryHome, crash, io)).toEqual({ strikes: 2, entry: null });
    expect(readLlamaQuarantine(memoryHome, io)).toEqual([]);
    expect(readLlamaQuarantineStrikes(memoryHome, io)).toMatchObject([
      { backend: 'vulkan', count: 2, signal: 'exit:0xc0000005' },
    ]);

    const third = recordLlamaStartupCrash(memoryHome, crash, io);

    expect(third.strikes).toBe(3);
    expect(third.entry).toMatchObject({ backend: 'vulkan', crashes: 3 });
    expect(isBinaryQuarantined(readLlamaQuarantine(memoryHome, io), 'vulkan', bin, io)).toBe(true);
    expect(readLlamaQuarantineStrikes(memoryHome, io)).toEqual([]);
  });

  it('starts the count over once a start reaches readiness', () => {
    const io = fakeIo(stat);
    recordLlamaStartupCrash(memoryHome, crash, io);
    recordLlamaStartupCrash(memoryHome, crash, io);

    expect(clearLlamaStartupStrikes(memoryHome, 'vulkan', io)).toBe(true);

    expect(recordLlamaStartupCrash(memoryHome, crash, io)).toEqual({ strikes: 1, entry: null });
  });

  it('writes nothing on readiness when there was no count', () => {
    const io = fakeIo(stat);
    expect(clearLlamaStartupStrikes(memoryHome, 'vulkan', io)).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it('starts the count over when an update replaces the binary', () => {
    const io = fakeIo(stat);
    recordLlamaStartupCrash(memoryHome, crash, io);
    recordLlamaStartupCrash(memoryHome, crash, io);
    const upgraded = fakeIo({ [bin]: { size: 26000, mtimeMs: 1_793_000_000_000 } });
    upgraded.files.set(
      llamaQuarantinePath(memoryHome),
      io.files.get(llamaQuarantinePath(memoryHome)) ?? '',
    );

    expect(recordLlamaStartupCrash(memoryHome, crash, upgraded)).toEqual({
      strikes: 1,
      entry: null,
    });
  });

  it("keeps one backend's count while another is quarantined", () => {
    const cuda = 'C:/Gezel/native/win32-x64-cuda/gezel-llama-server.exe';
    const io = fakeIo({ ...stat, [cuda]: { size: 30000, mtimeMs: 1 } });
    recordLlamaStartupCrash(memoryHome, crash, io);
    recordLlamaQuarantine(
      memoryHome,
      { backend: 'cuda', binaryPath: cuda, signal: 'SIGILL', reason: 'r' },
      io,
    );

    expect(readLlamaQuarantineStrikes(memoryHome, io)).toMatchObject([
      { backend: 'vulkan', count: 1 },
    ]);
    expect(readLlamaQuarantine(memoryHome, io).map((e) => e.backend)).toEqual(['cuda']);
  });

  it('lifting a quarantine clears the entry and its count, so the build starts fresh', () => {
    const io = fakeIo(stat);
    for (let i = 0; i < LLAMA_QUARANTINE_STRIKES; i++)
      recordLlamaStartupCrash(memoryHome, crash, io);
    expect(readLlamaQuarantine(memoryHome, io)).toHaveLength(1);

    expect(clearLlamaQuarantine(memoryHome, 'vulkan', io)).toBe(true);

    expect(readLlamaQuarantine(memoryHome, io)).toEqual([]);
    expect(recordLlamaStartupCrash(memoryHome, crash, io)).toEqual({ strikes: 1, entry: null });
    expect(clearLlamaQuarantine(memoryHome, 'cuda', io)).toBe(false);
  });

  it('reads a file written before strikes, whose entries carry no count', () => {
    const io = fakeIo(stat);
    io.files.set(
      llamaQuarantinePath(memoryHome),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            backend: 'vulkan',
            fingerprint: '25888:1792000000000',
            signal: 'SIGILL',
            reason: 'r',
            at: 'x',
          },
        ],
      }),
    );

    expect(readLlamaQuarantine(memoryHome, io)[0]?.crashes).toBeUndefined();
    expect(readLlamaQuarantineStrikes(memoryHome, io)).toEqual([]);
    expect(isBinaryQuarantined(readLlamaQuarantine(memoryHome, io), 'vulkan', bin, io)).toBe(true);
  });
});

describe('resolveAvailableLlamaBinary with an unusable build', () => {
  const paths: Record<string, string> = {
    cuda: '/n/linux-x64-cuda/gezel-llama-server',
    vulkan: '/n/linux-x64-vulkan/gezel-llama-server',
    cpu: '/n/linux-x64-cpu/gezel-llama-server',
  };
  const resolve = (backend: string) => paths[backend] ?? null;

  it('demotes past a present-but-unusable backend and reports which', () => {
    const quarantined: LlamaQuarantineEntry[] = [
      {
        backend: 'cuda',
        fingerprint: 'x',
        signal: 'SIGILL',
        reason: 'r',
        at: '2026-07-31T18:32:00.000Z',
      },
    ];
    const resolved = resolveAvailableLlamaBinary(
      'cuda',
      resolve,
      true,
      (backend) => !quarantined.some((e) => e.backend === backend),
    );

    // The exact shape of the incident that motivated this: CUDA detected,
    // CUDA binary present, CUDA unrunnable, Vulkan sitting beside it.
    expect(resolved).toEqual({
      backend: 'vulkan',
      path: paths.vulkan,
      fallbackFrom: 'cuda',
      skippedUnusable: ['cuda'],
    });
  });

  it('honors an explicit pin instead of quietly overriding the user', () => {
    const resolved = resolveAvailableLlamaBinary('cuda', resolve, false, () => false);
    expect(resolved).toEqual({ backend: 'cuda', path: paths.cuda });
  });

  it('leaves the normal path untouched when nothing is quarantined', () => {
    expect(resolveAvailableLlamaBinary('cuda', resolve, true, () => true)).toEqual({
      backend: 'cuda',
      path: paths.cuda,
    });
    expect(resolveAvailableLlamaBinary('cuda', resolve, true)).toEqual({
      backend: 'cuda',
      path: paths.cuda,
    });
  });

  it('returns null when every candidate is unusable', () => {
    expect(resolveAvailableLlamaBinary('cuda', resolve, true, () => false)).toBeNull();
  });
});
