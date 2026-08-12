import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installedNodePath,
  installedPnpmPath,
  resolveAutostartNodePath,
  resolveAutostartPnpmPath,
} from './runtime.js';

let workRoot: string;
let home: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-autostart-runtime-'));
  home = join(workRoot, 'home');
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function writeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'node');
  await chmod(path, 0o755);
}

describe('resolveAutostartNodePath', () => {
  it('uses the verified bundled runtime in packaged mode without consulting PATH', async () => {
    const bundledNodePath = installedNodePath(home);
    await writeExecutable(bundledNodePath);
    const lookupNodeOnPath = vi.fn().mockRejectedValue(new Error('PATH must not be consulted'));

    await expect(
      resolveAutostartNodePath({
        packaged: true,
        home,
        bundledNodePath,
        lookupNodeOnPath,
      }),
    ).resolves.toBe(bundledNodePath);
    expect(lookupNodeOnPath).not.toHaveBeenCalled();
  });

  it('rejects an unrelated global runtime in packaged mode', async () => {
    const bundledNodePath = join(workRoot, 'global', 'node');
    await writeExecutable(bundledNodePath);

    await expect(
      resolveAutostartNodePath({ packaged: true, home, bundledNodePath }),
    ).rejects.toThrow(/refused an untrusted Node path/i);
  });

  it('fails closed when the packaged supervisor did not authenticate a runtime', async () => {
    const lookupNodeOnPath = vi.fn().mockResolvedValue('/usr/bin/node');
    await expect(
      resolveAutostartNodePath({ packaged: true, home, lookupNodeOnPath }),
    ).rejects.toThrow(/verified bundled Node runtime is unavailable/i);
    expect(lookupNodeOnPath).not.toHaveBeenCalled();
  });

  it('fails closed when the packaged runtime disappeared', async () => {
    const bundledNodePath = installedNodePath(home);
    await expect(
      resolveAutostartNodePath({ packaged: true, home, bundledNodePath }),
    ).rejects.toThrow(/verified bundled Node runtime is unavailable/i);
  });

  it('fails closed when the packaged runtime lost execute permission on Unix', async () => {
    const bundledNodePath = installedNodePath(home, 'linux');
    await mkdir(dirname(bundledNodePath), { recursive: true });
    await writeFile(bundledNodePath, 'node');
    await expect(
      resolveAutostartNodePath({ packaged: true, home, bundledNodePath, platform: 'linux' }),
    ).rejects.toThrow(/not executable/i);
  });

  it('retains PATH lookup as a development-only fallback', async () => {
    const developmentNode = join(workRoot, 'dev-bin', 'node');
    await writeExecutable(developmentNode);
    const lookupNodeOnPath = vi.fn().mockResolvedValue(developmentNode);

    await expect(
      resolveAutostartNodePath({ packaged: false, home, lookupNodeOnPath }),
    ).resolves.toBe(developmentNode);
    expect(lookupNodeOnPath).toHaveBeenCalledOnce();
  });

  it('requires the verified bundled pnpm entrypoint in packaged mode', async () => {
    const bundledPnpmPath = installedPnpmPath(home);
    await writeExecutable(bundledPnpmPath);
    await expect(resolveAutostartPnpmPath({ packaged: true, home, bundledPnpmPath })).resolves.toBe(
      bundledPnpmPath,
    );
    await expect(resolveAutostartPnpmPath({ packaged: true, home })).rejects.toThrow(
      /verified bundled pnpm runtime is unavailable/i,
    );
  });

  it('does not require a pnpm override for development autostart', async () => {
    await expect(resolveAutostartPnpmPath({ packaged: false, home })).resolves.toBeUndefined();
  });

  it('derives the platform-specific installed path', () => {
    expect(installedNodePath('/home/tester/.gezel', 'linux')).toBe('/home/tester/.gezel/bin/node');
    expect(installedNodePath('C:\\Users\\tester\\.gezel', 'win32')).toBe(
      'C:\\Users\\tester\\.gezel\\bin\\node.exe',
    );
    expect(installedPnpmPath('C:\\Users\\tester\\.gezel', 'win32')).toBe(
      'C:\\Users\\tester\\.gezel\\bin\\pnpm-runtime\\bin\\pnpm.mjs',
    );
  });
});
