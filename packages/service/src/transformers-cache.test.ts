import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type TransformersEnv,
  pinTransformersCacheDir,
  transformersCacheDir,
} from './transformers-cache.js';

const dirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'gezel-hfcache-'));
  dirs.push(base);
  // A not-yet-existing subdir so we exercise the mkdir path.
  return join(base, 'hf-cache');
}

function fakeEnv(): TransformersEnv {
  return { cacheDir: 'UNSET', useFSCache: false, allowRemoteModels: false };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('transformersCacheDir', () => {
  it('is the engines/hf-cache dir under home', () => {
    expect(transformersCacheDir('/home/x')).toBe(join('/home/x', 'engines', 'hf-cache'));
  });
});

describe('pinTransformersCacheDir', () => {
  it('creates the dir and points the transformers env at it', async () => {
    const dir = await freshCacheDir();
    const env = fakeEnv();
    await pinTransformersCacheDir(dir, async () => env);
    expect(env.cacheDir).toBe(dir);
    expect(env.useFSCache).toBe(true);
    expect(env.allowRemoteModels).toBe(true);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('aligns global fetch + Response to one undici realm', async () => {
    // The transformers.js FS cache is gated on `response instanceof Response`
    // against the *global* Response; a fetch/Response realm split (seen in the
    // bundled daemon) defeats it. After a pin, both must come from one undici
    // so the invariant holds.
    const undici = (await import('undici')) as unknown as Record<string, unknown>;
    await pinTransformersCacheDir(await freshCacheDir(), async () => fakeEnv());
    const g = globalThis as unknown as Record<string, unknown>;
    expect(g.fetch).toBe(undici.fetch);
    expect(g.Response).toBe(undici.Response);
  });

  it('is idempotent per dir — loads the env only once', async () => {
    const dir = await freshCacheDir();
    let calls = 0;
    const load = async () => {
      calls++;
      return fakeEnv();
    };
    await pinTransformersCacheDir(dir, load);
    await pinTransformersCacheDir(dir, load);
    expect(calls).toBe(1);
  });

  it('is best-effort: a failing env loader does not throw', async () => {
    const dir = await freshCacheDir();
    await expect(
      pinTransformersCacheDir(dir, async () => {
        throw new Error('no transformers here');
      }),
    ).resolves.toBeUndefined();
  });
});
