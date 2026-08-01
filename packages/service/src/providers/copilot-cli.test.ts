import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copilotPlatformPackages, resolveCopilotCliPath } from './copilot-cli.js';

const WIN = { platform: 'win32', arch: 'x64' } as const;
const PLATFORM_PKG = '@github/copilot-win32-x64';

let dir: string;

function isolate(overrides: Record<string, unknown> = {}) {
  return { ...WIN, env: {} as NodeJS.ProcessEnv, ...overrides };
}

async function writePackage(
  root: string,
  name: string,
  files: string[],
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const pkgDir = join(root, ...name.split('/'));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  );
  for (const file of files) await writeFile(join(pkgDir, file), '');
  return pkgDir;
}

beforeEach(async () => {
  // Resolved, because the pnpm-isolated case below re-anchors its walk on
  // `realpathSync` of the store symlink — and macOS hands out `/var/...`
  // tmpdirs that resolve to `/private/var/...`.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-copilot-cli-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('copilotPlatformPackages', () => {
  it('offers both libc variants on linux and one elsewhere', () => {
    expect(copilotPlatformPackages('linux', 'x64')).toEqual([
      '@github/copilot-linux-x64',
      '@github/copilot-linuxmusl-x64',
    ]);
    expect(copilotPlatformPackages('win32', 'x64')).toEqual([PLATFORM_PKG]);
    expect(copilotPlatformPackages('darwin', 'arm64')).toEqual(['@github/copilot-darwin-arm64']);
  });
});

describe('resolveCopilotCliPath', () => {
  it('finds the platform package through a pnpm-isolated managed install', async () => {
    // The layout that broke: the platform package is an optional dep of
    // `@github/copilot`, so pnpm files it in the virtual store rather
    // than anywhere above the SDK's own directory.
    const root = join(dir, 'install', 'package');
    const store = join(root, 'node_modules', '.pnpm', '@github+copilot@1.0.73', 'node_modules');
    const real = await writePackage(store, '@github/copilot', ['npm-loader.js']);
    const platform = await writePackage(store, PLATFORM_PKG, ['index.js']);
    await mkdir(join(root, 'node_modules', '@github'), { recursive: true });
    await symlink(real, join(root, 'node_modules', '@github', 'copilot'), 'junction');

    expect(resolveCopilotCliPath(isolate({ installRoot: root }))).toEqual({
      path: join(platform, 'index.js'),
      source: 'managed',
    });
  });

  it('prefers the declared native binary over the index.js loader', async () => {
    // The SDK launches a `.js` path with `process.execPath`, which is
    // Electron in the embedded daemon and mangles the CLI's argv.
    const root = join(dir, 'install', 'package');
    const platform = await writePackage(
      join(root, 'node_modules'),
      PLATFORM_PKG,
      ['index.js', 'copilot.exe'],
      { exports: { '.': './copilot.exe' }, bin: { [PLATFORM_PKG]: 'copilot.exe' } },
    );

    expect(resolveCopilotCliPath(isolate({ installRoot: root }))).toEqual({
      path: join(platform, 'copilot.exe'),
      source: 'managed',
    });
  });

  it('falls back to index.js when the manifest declares no binary', async () => {
    const root = join(dir, 'install', 'package');
    const platform = await writePackage(join(root, 'node_modules'), PLATFORM_PKG, ['index.js']);

    expect(resolveCopilotCliPath(isolate({ installRoot: root }))).toEqual({
      path: join(platform, 'index.js'),
      source: 'managed',
    });
  });

  it('finds the platform package in a flat, hoisted managed install', async () => {
    const root = join(dir, 'install', 'package');
    const modules = join(root, 'node_modules');
    await writePackage(modules, '@github/copilot', ['npm-loader.js']);
    const platform = await writePackage(modules, PLATFORM_PKG, ['index.js']);

    expect(resolveCopilotCliPath(isolate({ installRoot: root }))).toEqual({
      path: join(platform, 'index.js'),
      source: 'managed',
    });
  });

  it('falls back to a CLI the user installed themselves on PATH', async () => {
    const prefix = join(dir, 'npm-global');
    const platform = await writePackage(join(prefix, 'node_modules'), PLATFORM_PKG, ['index.js']);
    await writePackage(join(prefix, 'node_modules'), '@github/copilot', ['npm-loader.js']);
    await writeFile(join(prefix, 'copilot.cmd'), '');

    expect(resolveCopilotCliPath(isolate({ env: { PATH: prefix } }))).toEqual({
      path: join(platform, 'index.js'),
      source: 'path',
    });
  });

  it('accepts a standalone binary on PATH but never a bare .cmd shim', async () => {
    const withExe = join(dir, 'standalone');
    const withShim = join(dir, 'shim-only');
    await mkdir(withExe, { recursive: true });
    await mkdir(withShim, { recursive: true });
    await writeFile(join(withExe, 'copilot.exe'), '');
    await writeFile(join(withShim, 'copilot.cmd'), '');

    expect(resolveCopilotCliPath(isolate({ env: { PATH: withExe } }))).toEqual({
      path: join(withExe, 'copilot.exe'),
      source: 'path',
    });
    // A shim with no package tree around it is unspawnable — Node's
    // shell-less spawn cannot execute a batch file.
    expect(resolveCopilotCliPath(isolate({ env: { PATH: withShim } }))).toBeNull();
  });

  it('prefers the managed install over PATH, and COPILOT_CLI_PATH over both', async () => {
    const root = join(dir, 'install', 'package');
    const platform = await writePackage(join(root, 'node_modules'), PLATFORM_PKG, ['index.js']);
    const onPath = join(dir, 'standalone');
    await mkdir(onPath, { recursive: true });
    await writeFile(join(onPath, 'copilot.exe'), '');

    expect(resolveCopilotCliPath(isolate({ installRoot: root, env: { PATH: onPath } }))).toEqual({
      path: join(platform, 'index.js'),
      source: 'managed',
    });

    expect(
      resolveCopilotCliPath(
        isolate({
          installRoot: root,
          env: { PATH: onPath, COPILOT_CLI_PATH: '/opt/copilot' },
        }),
      ),
    ).toEqual({ path: '/opt/copilot', source: 'env' });
  });

  it('returns null when nothing is installed, leaving the SDK its own lookup', () => {
    expect(
      resolveCopilotCliPath(
        isolate({ installRoot: join(dir, 'absent'), env: { PATH: [dir, ''].join(delimiter) } }),
      ),
    ).toBeNull();
  });
});
