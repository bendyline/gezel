import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelFileDownloadError,
  type PinnedModelFile,
  TRANSFORMERS_MODULE,
  type TransformersEnv,
  ensureVerifiedModelFile,
  isCorruptTransformersCacheFailure,
  isMissingModule,
  loadTransformersModelWithCacheRecovery,
  pinTransformersCacheDir,
  removeTransformersModelCache,
  transformersCacheDir,
  withTransformersModelCacheLock,
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

describe('transformers model cache coordination', () => {
  it('serializes concurrent first-use work for the same model', async () => {
    const dir = await freshCacheDir();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstInside = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => {
      events.push('first:start');
      firstStarted();
      await firstHeld;
      events.push('first:end');
    });
    await firstInside;
    const second = withTransformersModelCacheLock(
      dir,
      'Xenova/test-model',
      async () => {
        events.push('second');
      },
      { pollMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases the model lock when loading throws', async () => {
    const dir = await freshCacheDir();
    await expect(
      withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => {
        throw new Error('load failed');
      }),
    ).rejects.toThrow('load failed');
    await expect(
      withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => 'recovered'),
    ).resolves.toBe('recovered');
  });

  it('removes only the corrupt named model repository', async () => {
    const dir = await freshCacheDir();
    const corrupt = join(dir, 'Xenova', 'test-model', 'onnx');
    const healthy = join(dir, 'Xenova', 'other-model');
    await mkdir(corrupt, { recursive: true });
    await mkdir(healthy, { recursive: true });
    await writeFile(join(corrupt, 'model.onnx'), 'partial protobuf');
    await writeFile(join(healthy, 'config.json'), '{}');

    await removeTransformersModelCache(dir, 'Xenova/test-model');

    await expect(stat(join(dir, 'Xenova', 'test-model'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(join(healthy, 'config.json'))).isFile()).toBe(true);
    await expect(removeTransformersModelCache(dir, '../outside')).rejects.toThrow(
      /unsafe transformers model id/,
    );
  });

  it('recognises cached ONNX/protobuf corruption through an error cause', () => {
    const error = new Error('Load model from cache failed', {
      cause: new Error('Protobuf parsing failed'),
    });
    expect(isCorruptTransformersCacheFailure(error)).toBe(true);
    expect(isCorruptTransformersCacheFailure(new Error('socket hang up'))).toBe(false);
  });

  it('deletes a proven-corrupt model and retries its load exactly once', async () => {
    const dir = await freshCacheDir();
    const modelFile = join(dir, 'Xenova', 'test-model', 'onnx', 'model.onnx');
    await mkdir(join(dir, 'Xenova', 'test-model', 'onnx'), { recursive: true });
    await writeFile(modelFile, 'partial protobuf');
    let calls = 0;
    let corruptNotices = 0;

    const loaded = await loadTransformersModelWithCacheRecovery(
      dir,
      'Xenova/test-model',
      async () => {
        calls++;
        if (calls === 1) {
          expect((await stat(modelFile)).isFile()).toBe(true);
          throw new Error('Load model failed', { cause: new Error('Protobuf parsing failed') });
        }
        await expect(stat(modelFile)).rejects.toMatchObject({ code: 'ENOENT' });
        return 'loaded';
      },
      () => {
        corruptNotices++;
      },
    );

    expect(loaded).toBe('loaded');
    expect(calls).toBe(2);
    expect(corruptNotices).toBe(1);
  });

  it('takes over a lock whose holder died mid-download', async () => {
    // A quit during first run kills the holder before its `finally`, and the
    // age limit alone would keep the model locked for hours.
    const dir = await freshCacheDir();
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid ?? 0));
    });
    const first = withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => {
      const locks = join(dir, '.gezel-locks');
      const [lock] = await readdir(locks);
      return join(locks, lock!);
    });
    const lockDir = await first;
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid }));

    await expect(
      withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => 'acquired', {
        timeoutMs: 2_000,
        pollMs: 5,
      }),
    ).resolves.toBe('acquired');
  });

  it('keeps waiting on a lock whose holder is alive', async () => {
    const dir = await freshCacheDir();
    const lockDir = await withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => {
      const locks = join(dir, '.gezel-locks');
      return join(locks, (await readdir(locks))[0]!);
    });
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }));

    await expect(
      withTransformersModelCacheLock(dir, 'Xenova/test-model', async () => 'acquired', {
        timeoutMs: 60,
        pollMs: 5,
      }),
    ).rejects.toThrow(/timed out waiting/);
  });
});

describe('ensureVerifiedModelFile', () => {
  const MODEL = 'Xenova/test-model';
  const BYTES = Buffer.alloc(256 * 1024, 7);
  const DIGEST = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`;
  const pinned: PinnedModelFile = { file: 'onnx/model.onnx', digest: DIGEST, revision: 'abc123' };

  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /**
   * Serves `body` in slow 16 KiB slices, declaring `declaredLength`, and
   * optionally drops the connection after `cutAfter` bytes.
   */
  async function serve(opts: {
    body?: Buffer;
    declaredLength?: number;
    cutAfter?: number;
    status?: number;
  }): Promise<{ host: string; requests: string[] }> {
    const body = opts.body ?? BYTES;
    const requests: string[] = [];
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      if (opts.status) {
        res.writeHead(opts.status);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(opts.declaredLength ?? body.length) });
      const end = opts.cutAfter ?? body.length;
      let offset = 0;
      const tick = () => {
        if (offset >= end) {
          if (opts.cutAfter !== undefined) res.destroy();
          else res.end();
          return;
        }
        const next = Math.min(end, offset + 16 * 1024);
        res.write(body.subarray(offset, next));
        offset = next;
        setTimeout(tick, 2);
      };
      tick();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    return { host: `http://127.0.0.1:${port}/`, requests };
  }

  const source = (host: string) => ({
    remoteHost: host,
    remotePathTemplate: '{model}/resolve/{revision}/',
  });
  const targetOf = (dir: string) => join(dir, 'Xenova', 'test-model', 'onnx', 'model.onnx');

  it('never exposes a partial file at the path onnxruntime reads', async () => {
    const dir = await freshCacheDir();
    const { host, requests } = await serve({});
    const target = targetOf(dir);
    let sawPartial = false;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const info = await stat(target).catch(() => null);
        if (info && info.size !== BYTES.length) sawPartial = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    const outcome = await ensureVerifiedModelFile(dir, MODEL, pinned, source(host));
    polling = false;
    await poll;

    expect(outcome).toBe('downloaded');
    expect(sawPartial).toBe(false);
    expect(await readFile(target)).toEqual(BYTES);
    expect(requests).toEqual(['/Xenova/test-model/resolve/abc123/onnx/model.onnx']);
    expect((await readdir(join(dir, 'Xenova', 'test-model', 'onnx'))).sort()).toEqual([
      'model.onnx',
      'model.onnx.gezel-verified',
    ]);
  });

  it('leaves nothing behind when the connection drops mid-file', async () => {
    const dir = await freshCacheDir();
    const { host } = await serve({ cutAfter: 64 * 1024 });

    await expect(ensureVerifiedModelFile(dir, MODEL, pinned, source(host))).rejects.toThrow();

    expect(await readdir(join(dir, 'Xenova', 'test-model', 'onnx'))).toEqual([]);
  });

  it('refuses bytes that end early or do not match the pin', async () => {
    const dir = await freshCacheDir();
    const short = await serve({ body: BYTES.subarray(0, 1024), declaredLength: 1024 });
    await expect(ensureVerifiedModelFile(dir, MODEL, pinned, source(short.host))).rejects.toThrow(
      ModelFileDownloadError,
    );
    await expect(stat(targetOf(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a partial file an earlier run left at the cache path', async () => {
    const dir = await freshCacheDir();
    const target = targetOf(dir);
    await mkdir(join(dir, 'Xenova', 'test-model', 'onnx'), { recursive: true });
    await writeFile(target, BYTES.subarray(0, 4096));
    await writeFile(`${target}.download-99999-deadbeef`, 'orphaned temp');
    const { host } = await serve({});

    expect(await ensureVerifiedModelFile(dir, MODEL, pinned, source(host))).toBe('downloaded');

    expect(await readFile(target)).toEqual(BYTES);
    expect(await readdir(join(dir, 'Xenova', 'test-model', 'onnx'))).not.toContain(
      'model.onnx.download-99999-deadbeef',
    );
  });

  it('keeps a complete cached file without touching the network', async () => {
    const dir = await freshCacheDir();
    const target = targetOf(dir);
    await mkdir(join(dir, 'Xenova', 'test-model', 'onnx'), { recursive: true });
    await writeFile(target, BYTES);
    const { host, requests } = await serve({ status: 500 });

    expect(await ensureVerifiedModelFile(dir, MODEL, pinned, source(host))).toBe('cached');
    expect(await ensureVerifiedModelFile(dir, MODEL, pinned, source(host))).toBe('cached');
    expect(requests).toEqual([]);
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
