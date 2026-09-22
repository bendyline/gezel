import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneLlamaDiskCache, withLlamaDiskCache } from './disk-cache.js';

describe('llama snapshot retention', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-kv-retention-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function file(relative: string, size: number, seconds: number) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(size));
    await utimes(path, seconds, seconds);
    return path;
  }

  it('shares the quota across models, replicas and all prefix namespaces, evicting oldest first', async () => {
    const oldest = await file(`${'a'.repeat(24)}/sess-old.bin`, 30, 1);
    const prefix = await file(`${'b'.repeat(24)}/prefix-gp-${'c'.repeat(16)}.bin`, 20, 2);
    const replica = await file(
      `${'b'.repeat(24)}/replica-1/prefix-gezel-${'d'.repeat(16)}.bin`,
      25,
      3,
    );
    const latest = await file(`${'a'.repeat(24)}/prefix-${'e'.repeat(16)}.bin`, 40, 4);
    expect(await pruneLlamaDiskCache(root, 65)).toEqual({
      bytes: 65,
      removedBytes: 50,
      removedFiles: 2,
    });
    await expect(readFile(oldest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(prefix)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(replica)).length).toBe(25);
    expect((await readFile(latest)).length).toBe(40);
  });

  it('preserves models, product files and unknown directory layouts', async () => {
    const retained = await Promise.all(
      [
        'model.gguf',
        'state.json',
        'notes.bin',
        'other/sess-old.bin',
        `${'a'.repeat(24)}/unexpected/sess-old.bin`,
      ].map((p) => file(p, 50, 1)),
    );
    await file('sess-managed.bin', 50, 2);
    expect(await pruneLlamaDiskCache(root, 1)).toEqual({
      bytes: 0,
      removedBytes: 50,
      removedFiles: 1,
    });
    for (const path of retained) expect((await readFile(path)).length).toBe(50);
  });

  it('does not traverse a directory junction, including a linked cache root', async () => {
    const outside = join(root, 'outside');
    const cache = join(root, 'slots');
    await mkdir(cache);
    await file('outside/sess-precious.bin', 100, 1);
    await symlink(outside, join(cache, 'a'.repeat(24)), 'junction');
    expect((await pruneLlamaDiskCache(cache, 1)).removedFiles).toBe(0);
    expect((await pruneLlamaDiskCache(join(cache, 'a'.repeat(24)), 1)).removedFiles).toBe(0);
    expect((await readFile(join(outside, 'sess-precious.bin'))).length).toBe(100);
  });

  it('treats zero as explicit opt-out; removes an oversized entry with a positive quota', async () => {
    await file('sess-large.bin', 100, 1);
    expect((await pruneLlamaDiskCache(root, 0)).removedFiles).toBe(0);
    expect(await readdir(root)).toEqual(['sess-large.bin']);
    expect(await pruneLlamaDiskCache(root, 90)).toEqual({
      bytes: 0,
      removedBytes: 100,
      removedFiles: 1,
    });
    expect((await pruneLlamaDiskCache(join(root, 'missing'), 90)).bytes).toBe(0);
    await expect(pruneLlamaDiskCache(root, -1)).rejects.toThrow('Invalid');
  });

  it('serializes replicas and releases the lock when an operation fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: number[] = [];
    const first = withLlamaDiskCache(root, async () => {
      events.push(1);
      await gate;
      throw new Error('save failed');
    });
    const failure = expect(first).rejects.toThrow('save failed');
    const second = withLlamaDiskCache(root, async () => {
      events.push(2);
    });
    await Promise.resolve();
    expect(events).toEqual([1]);
    release();
    await Promise.all([failure, second]);
    expect(events).toEqual([1, 2]);
    await expect(withLlamaDiskCache(root, async () => 3)).resolves.toBe(3);
  });
});
