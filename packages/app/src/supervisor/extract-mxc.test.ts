import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MXC_VERSION, mxcInstallDir } from '@bendyline/gezel/native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMxcIfNeeded, provisionMxcExecutor } from './extract-mxc.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// The real launcher is 12 MB of Microsoft's bytes; tests pin stand-ins so the
// pinned-version path (the one packaged builds take) is exercised too.
vi.mock('@bendyline/gezel/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bendyline/gezel/native')>();
  const { createHash: hash } = await import('node:crypto');
  const digest = (s: string) => hash('sha256').update(s).digest('hex');
  const pins = { x64: digest('x64-launcher'), arm64: digest('arm64-launcher') };
  return {
    ...actual,
    MXC_EXECUTOR_SHA256: pins,
  };
});

let home: string;
let bundleDir: string;
const PINNED = MXC_VERSION;

async function stageBundle(contents: string, version = PINNED, manifest = true) {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, 'wxc-exec.exe'), contents);
  await writeFile(join(bundleDir, 'version.txt'), `${version}\n`);
  await writeFile(join(bundleDir, 'LICENSE.txt'), 'MIT');
  if (manifest) {
    await writeFile(join(bundleDir, 'sha256.txt'), `${sha(contents)}  wxc-exec.exe\n`);
  }
}

async function readSentinel(version = PINNED) {
  return JSON.parse(await readFile(join(mxcInstallDir(home, version), '.verified.json'), 'utf8'));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mxc-home-'));
  bundleDir = await mkdtemp(join(tmpdir(), 'gezel-mxc-bundle-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(bundleDir, { recursive: true, force: true });
});

describe('installMxcIfNeeded', () => {
  it('installs into the version-keyed directory the engine resolver also uses', async () => {
    await stageBundle('arm64-launcher');
    const result = await installMxcIfNeeded({ home, bundleDir });

    expect(result).toMatchObject({ action: 'fresh-install', verified: true, version: PINNED });
    expect(result.executorPath).toBe(join(mxcInstallDir(home, PINNED), 'wxc-exec.exe'));
    expect(await readFile(result.executorPath as string, 'utf8')).toBe('arm64-launcher');
  });

  it('records the arch the bytes were pinned for, not the host’s', async () => {
    // An x64 Electron build on an ARM64 machine ships the x64 launcher; the
    // sentinel must say which digest those bytes actually matched.
    await stageBundle('arm64-launcher');
    await installMxcIfNeeded({ home, bundleDir });
    expect(await readSentinel()).toMatchObject({
      engine: 'mxc',
      version: PINNED,
      arch: 'arm64',
      sha256: sha('arm64-launcher'),
      source: 'electron-bundle',
    });
  });

  it('refuses bytes that are not a pinned launcher, even with a matching manifest', async () => {
    await stageBundle('some-other-exe');
    const result = await installMxcIfNeeded({ home, bundleDir });
    expect(result).toMatchObject({ action: 'no-bundle', executorPath: null, verified: false });
    expect(existsSync(join(mxcInstallDir(home, PINNED), 'wxc-exec.exe'))).toBe(false);
  });

  it('counts the compiled-in pin as verification when no manifest shipped', async () => {
    await stageBundle('x64-launcher', PINNED, false);
    const result = await installMxcIfNeeded({ home, bundleDir });
    expect(result.verified).toBe(true);
  });

  it('leaves a bundle from another version unverified without a manifest', async () => {
    await stageBundle('future-launcher', '9.9.9', false);
    const result = await installMxcIfNeeded({ home, bundleDir });
    expect(result.executorPath).not.toBeNull();
    expect(result.verified).toBe(false);
  });

  it('is idempotent on a second run, and restores a missing sentinel', async () => {
    await stageBundle('x64-launcher');
    await installMxcIfNeeded({ home, bundleDir });
    await rm(join(mxcInstallDir(home, PINNED), '.verified.json'));

    const second = await installMxcIfNeeded({ home, bundleDir });
    expect(second.action).toBe('up-to-date');
    expect((await readSentinel()).sha256).toBe(sha('x64-launcher'));
  });

  it('rewrites a sentinel that vouches for different bytes', async () => {
    await stageBundle('x64-launcher');
    await installMxcIfNeeded({ home, bundleDir });
    await writeFile(
      join(mxcInstallDir(home, PINNED), '.verified.json'),
      JSON.stringify({ engine: 'mxc', version: PINNED, arch: 'x64', sha256: 'f'.repeat(64) }),
    );

    await installMxcIfNeeded({ home, bundleDir });
    expect((await readSentinel()).sha256).toBe(sha('x64-launcher'));
  });

  it('refreshes an installed launcher whose bytes drifted from the bundle', async () => {
    await stageBundle('x64-launcher');
    const first = await installMxcIfNeeded({ home, bundleDir });
    await writeFile(first.executorPath as string, 'tampered');

    const second = await installMxcIfNeeded({ home, bundleDir });
    expect(second.action).toBe('refreshed');
    expect(await readFile(second.executorPath as string, 'utf8')).toBe('x64-launcher');
  });

  it('refuses to install when the bundle fails its own integrity manifest', async () => {
    await stageBundle('x64-launcher');
    await writeFile(join(bundleDir, 'sha256.txt'), `${'0'.repeat(64)}  wxc-exec.exe\n`);
    const result = await installMxcIfNeeded({ home, bundleDir });
    expect(result).toMatchObject({ action: 'no-bundle', executorPath: null });
  });

  it('reports no-bundle rather than throwing when nothing shipped', async () => {
    const result = await installMxcIfNeeded({ home, bundleDir: join(bundleDir, 'absent') });
    expect(result).toMatchObject({ action: 'no-bundle', executorPath: null, verified: false });
  });
});

describe('provisionMxcExecutor', () => {
  const base = () => ({ home, bundleDir, runInPlace: false, platform: 'win32' as const });

  it('replaces an inherited launcher path in a packaged launch', async () => {
    await stageBundle('x64-launcher');
    const env: NodeJS.ProcessEnv = { GEZEL_MXC_EXEC: 'C:elsewherewxc-exec.exe' };
    await provisionMxcExecutor({ ...base(), packaged: true, env });
    expect(env.GEZEL_MXC_EXEC).toBe(join(mxcInstallDir(home, PINNED), 'wxc-exec.exe'));
  });

  it('leaves the variable unset in a packaged launch with no usable bundle', async () => {
    await stageBundle('some-other-exe');
    const env: NodeJS.ProcessEnv = { GEZEL_MXC_EXEC: 'C:elsewherewxc-exec.exe' };
    await provisionMxcExecutor({ ...base(), packaged: true, env });
    expect(env.GEZEL_MXC_EXEC).toBeUndefined();
  });

  it('keeps an operator-set launcher in development', async () => {
    await stageBundle('x64-launcher');
    const env: NodeJS.ProcessEnv = { GEZEL_MXC_EXEC: 'C:devwxc-exec.exe' };
    await provisionMxcExecutor({ ...base(), packaged: false, env });
    expect(env.GEZEL_MXC_EXEC).toBe('C:devwxc-exec.exe');
    expect(existsSync(join(mxcInstallDir(home, PINNED), 'wxc-exec.exe'))).toBe(false);
  });

  it('runs a store bundle in place without copying it into the home', async () => {
    await stageBundle('x64-launcher');
    const env: NodeJS.ProcessEnv = {};
    await provisionMxcExecutor({ ...base(), runInPlace: true, packaged: true, env });
    expect(env.GEZEL_MXC_EXEC).toBe(join(bundleDir, 'wxc-exec.exe'));
    expect(existsSync(mxcInstallDir(home, PINNED))).toBe(false);
  });

  it('does nothing off Windows', async () => {
    await stageBundle('x64-launcher');
    const env: NodeJS.ProcessEnv = { GEZEL_MXC_EXEC: 'inherited' };
    await provisionMxcExecutor({ ...base(), platform: 'darwin', packaged: true, env });
    expect(env.GEZEL_MXC_EXEC).toBe('inherited');
  });
});
