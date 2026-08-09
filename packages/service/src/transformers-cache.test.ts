import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSFORMERS_MODULE,
  type TransformersEnv,
  isMissingModule,
  pinTransformersCacheDir,
  transformersCacheDir,
} from './transformers-cache.js';

const ABSENT = '@bendyline/definitely-not-installed';

/** Node's own resolver error, so the detector is tested against the real shape. */
async function realImportError(specifier: string): Promise<unknown> {
  try {
    await import(/* @vite-ignore */ specifier);
    throw new Error(`expected ${specifier} to be missing`);
  } catch (err) {
    return err;
  }
}

/** The same shape, but naming a specifier we cannot actually uninstall here. */
function moduleNotFound(specifier: string): Error {
  const err: NodeJS.ErrnoException = new Error(
    `Cannot find package '${specifier}' imported from /app/dist/index.js`,
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

const dirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'gezel-hfcache-'));
  dirs.push(base);
  // A not-yet-existing subdir so we exercise the mkdir path.
  return join(base, 'hf-cache');
}

/** Same, without awaiting inside a capture window that would swallow the I/O. */
function freshCacheDirSync(): string {
  const base = mkdtempSync(join(tmpdir(), 'gezel-hfcache-'));
  dirs.push(base);
  return join(base, 'hf-cache');
}

/**
 * The logger writes its own lines straight to `process.stderr` and only reaches
 * for `console.*` when there are extra args, so warn/error have to be observed
 * at the stream.
 */
async function captureStderr(run: () => Promise<unknown>): Promise<string> {
  let captured = '';
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return captured;
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

  it('warns when the pin fails for a real reason', async () => {
    const stderr = await captureStderr(() =>
      pinTransformersCacheDir(freshCacheDirSync(), async () => {
        throw new Error('env is frozen');
      }),
    );
    expect(stderr).toContain('could not pin transformers cache dir');
  });

  it('stays quiet when the optional peer is simply not installed', async () => {
    // The base npm install omits the ML peers by design, so this path is a
    // supported configuration rather than a fault. Warning here made every
    // lean install look broken before it had done anything wrong.
    const stderr = await captureStderr(() =>
      pinTransformersCacheDir(freshCacheDirSync(), async () => {
        throw moduleNotFound(TRANSFORMERS_MODULE);
      }),
    );
    expect(stderr).toBe('');
  });
});

describe('isMissingModule', () => {
  it('recognises Node reporting a genuinely uninstalled package', async () => {
    expect(isMissingModule(await realImportError(ABSENT), ABSENT)).toBe(true);
  });

  it('does not fire for a different specifier in the same error', async () => {
    expect(isMissingModule(await realImportError(ABSENT), TRANSFORMERS_MODULE)).toBe(false);
  });

  it('does not fire when the package is installed but fails to load', () => {
    // A real failure inside transformers also names the package, which is why
    // matching on the message alone previously misreported it as "not
    // installed" and hid a genuine fault behind an install hint.
    const err = new Error(`Unable to get model file path or buffer (${TRANSFORMERS_MODULE})`);
    expect(isMissingModule(err, TRANSFORMERS_MODULE)).toBe(false);
  });

  it('ignores non-Error rejections', () => {
    expect(isMissingModule('nope', TRANSFORMERS_MODULE)).toBe(false);
  });
});
