import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UvRuntime, uvCacheDir, uvChildEnv } from './uv-runtime.js';

describe('uv cache location', () => {
  it('keeps the cache under the Gezel home unless the person chose one', () => {
    const home = join(tmpdir(), 'gezel-home');
    expect(uvChildEnv({ PATH: '/bin' }, home)).toEqual({
      PATH: '/bin',
      UV_CACHE_DIR: join(home, 'engines', 'uv', 'cache'),
    });
    expect(uvChildEnv({ UV_CACHE_DIR: '/mnt/uv' }, home).UV_CACHE_DIR).toBe('/mnt/uv');
    expect(uvChildEnv({ UV_CACHE_DIR: ' ' }, home).UV_CACHE_DIR).toBe(uvCacheDir(home));
  });

  describe('UvRuntime', () => {
    let home: string;
    const prior = process.env.UV_CACHE_DIR;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'gezel-uv-cache-'));
      delete process.env.UV_CACHE_DIR;
    });
    afterEach(async () => {
      if (prior === undefined) delete process.env.UV_CACHE_DIR;
      else process.env.UV_CACHE_DIR = prior;
      await rm(home, { recursive: true, force: true });
    });

    it('hands every uv run the home cache', async () => {
      const envs: Array<NodeJS.ProcessEnv | undefined> = [];
      const exec = ((
        cmd: string,
        _opts: unknown,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'uv --version') cb(null, { stdout: 'uv 0.5.12', stderr: '' });
        else if (cmd.includes('--version')) cb(null, { stdout: 'Python 3.11.7', stderr: '' });
        else cb(new Error('not found'), { stdout: '', stderr: '' });
        return {} as unknown;
      }) as unknown as ConstructorParameters<typeof UvRuntime>[0]['exec'];
      const spawn = ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        envs.push(options.env);
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(async () => {
          const venv = args.includes('venv') ? args.at(-1) : undefined;
          if (venv) {
            const bin = process.platform === 'win32' ? join(venv, 'Scripts') : join(venv, 'bin');
            await mkdir(bin, { recursive: true });
            await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
          }
          child.emit('exit', 0);
        });
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as unknown as ConstructorParameters<typeof UvRuntime>[0]['spawn'];

      const uv = new UvRuntime({ home, bundledUvBin: null, exec, spawn, onLog: () => {} });
      await uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] });

      expect(envs.length).toBeGreaterThanOrEqual(2);
      for (const env of envs) expect(env?.UV_CACHE_DIR).toBe(uvCacheDir(home));
    });
  });
});
