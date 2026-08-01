import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAvailableLlamaBinary } from './llama-backend.js';
import type { LlamaQuarantineEntry, QuarantineIo } from './llama-quarantine.js';
import {
  binaryFingerprint,
  isBinaryQuarantined,
  llamaQuarantinePath,
  readLlamaQuarantine,
  recordLlamaQuarantine,
} from './llama-quarantine.js';

const dirs: string[] = [];
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
  it('records a crashed backend and matches it back by binary identity', async () => {
    const home = await tmpHome();
    const bin = '/opt/Gezel/native-bin/linux-x64-cuda/gezel-llama-server';
    const io = fakeIo({ [bin]: { size: 14600, mtimeMs: 1_785_547_847_453 } });

    const entry = recordLlamaQuarantine(
      home,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'crashed before ready' },
      io,
    );

    expect(entry).toMatchObject({ backend: 'cuda', signal: 'SIGILL' });
    expect(entry?.fingerprint).toBe('14600:1785547847453');
    expect(isBinaryQuarantined(readLlamaQuarantine(home, io), 'cuda', bin, io)).toBe(true);
  });

  it('expires the entry when the binary is replaced, so a fixed build is retried', async () => {
    const home = await tmpHome();
    const bin = '/opt/Gezel/native-bin/linux-x64-cuda/gezel-llama-server';
    const io = fakeIo({ [bin]: { size: 14600, mtimeMs: 1_785_547_847_453 } });
    recordLlamaQuarantine(
      home,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'crashed before ready' },
      io,
    );

    // A native release replaces the binary in place. This is the case a
    // version-keyed quarantine gets wrong: the SIGILL fix that motivated
    // this file was a compiler-flag change at an unchanged llama.cpp pin.
    const upgraded = fakeIo({ [bin]: { size: 21344, mtimeMs: 1_785_999_999_999 } });
    upgraded.files.set(llamaQuarantinePath(home), io.files.get(llamaQuarantinePath(home)) ?? '');

    expect(isBinaryQuarantined(readLlamaQuarantine(home, upgraded), 'cuda', bin, upgraded)).toBe(
      false,
    );
  });

  it('replaces rather than appends when the same backend crashes again', async () => {
    const home = await tmpHome();
    const bin = '/bin/llama';
    const io = fakeIo({ [bin]: { size: 10, mtimeMs: 1 } });
    recordLlamaQuarantine(
      home,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'a' },
      io,
    );
    recordLlamaQuarantine(
      home,
      { backend: 'cuda', binaryPath: bin, signal: 'SIGILL', reason: 'b' },
      io,
    );

    const entries = readLlamaQuarantine(home, io);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('b');
  });

  it('returns null when the binary cannot be fingerprinted', async () => {
    const home = await tmpHome();
    const io = fakeIo({});
    expect(
      recordLlamaQuarantine(
        home,
        { backend: 'cuda', binaryPath: '/gone', signal: 'SIGILL', reason: 'x' },
        io,
      ),
    ).toBeNull();
  });

  it('treats a missing or malformed file as no quarantine', async () => {
    const home = await tmpHome();
    const io = fakeIo({});
    expect(readLlamaQuarantine(home, io)).toEqual([]);
    io.files.set(llamaQuarantinePath(home), '{ not json');
    expect(readLlamaQuarantine(home, io)).toEqual([]);
    io.files.set(llamaQuarantinePath(home), JSON.stringify({ schemaVersion: 99, entries: [] }));
    expect(readLlamaQuarantine(home, io)).toEqual([]);
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
