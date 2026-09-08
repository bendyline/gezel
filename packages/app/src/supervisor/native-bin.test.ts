import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNativeBinaryPath, verifyLlamaBinaryAgainstCheckoutPin } from './native-bin.js';

/**
 * native-bin relies on process.platform/arch + a path walk relative to
 * a caller-supplied mainMetaUrl. We can't mock the platform, but we
 * can set up a fake `dist/main.js` + `native-bin/<platform>/` tree in
 * a temp dir and assert the resolver finds it for the current host.
 */

let tmp: string;
let mainMetaUrl: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gezel-native-bin-test-'));
  const distDir = join(tmp, 'dist');
  await mkdir(distDir, { recursive: true });
  // Pretend the Electron main bundle lives at `dist/main.js`.
  const fakeMain = join(distDir, 'main.js');
  await writeFile(fakeMain, '// stub\n', 'utf8');
  mainMetaUrl = pathToFileURL(fakeMain).href;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function platformKey(): string | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
    if (process.arch === 'arm64') return 'linux-arm64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return null;
}

describe('resolveNativeBinaryPath', () => {
  it('returns null when nothing is bundled', () => {
    expect(resolveNativeBinaryPath('sd-server', mainMetaUrl)).toBeNull();
  });

  it('finds a bundled binary in native-bin/<platform>/ next to the main bundle', async () => {
    const key = platformKey();
    if (!key) {
      // Skip on unsupported platforms — the helper is a no-op there.
      return;
    }
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binDir = join(tmp, 'native-bin', key);
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, `sd-server${ext}`);
    await writeFile(binPath, Buffer.from([0]));

    const resolved = resolveNativeBinaryPath('sd-server', mainMetaUrl);
    expect(resolved).toBe(binPath);
  });

  it('returns the real app.asar.unpacked path for a packaged native binary', async () => {
    const key = platformKey();
    if (!key) return;

    const ext = process.platform === 'win32' ? '.exe' : '';
    const packagedMain = join(tmp, 'resources', 'app.asar', 'dist', 'main.js');
    const binDir = join(tmp, 'resources', 'app.asar.unpacked', 'native-bin', `${key}-metal`);
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, `gezel-llama-server${ext}`);
    await writeFile(binPath, Buffer.from([0]));

    const resolved = resolveNativeBinaryPath(
      'llama-server',
      pathToFileURL(packagedMain).href,
      'metal',
    );
    expect(resolved).toBe(binPath);
    expect(resolved).not.toContain(
      `${join('resources', 'app.asar')}${process.platform === 'win32' ? '\\' : '/'}`,
    );
  });

  it('prefers a locally compiled binary over the fetched staging payload in dev', async () => {
    const key = platformKey();
    if (!key) return;

    const ext = process.platform === 'win32' ? '.exe' : '';
    const checkout = join(tmp, 'checkout');
    const checkoutMain = join(checkout, 'packages', 'app', 'dist', 'main.js');
    const stagedDir = join(checkout, 'packages', 'app', 'native-bin', `${key}-vulkan`);
    const localDir = join(checkout, 'native', 'build', `${key}-vulkan`);
    await mkdir(join(checkout, 'packages', 'app', 'dist'), { recursive: true });
    await mkdir(stagedDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(checkoutMain, '// stub\n', 'utf8');
    const staged = join(stagedDir, `gezel-llama-server${ext}`);
    const local = join(localDir, `gezel-llama-server${ext}`);
    await writeFile(staged, Buffer.from([0]));
    await writeFile(local, Buffer.from([0]));
    const checkoutMainUrl = pathToFileURL(checkoutMain).href;

    expect(
      resolveNativeBinaryPath('llama-server', checkoutMainUrl, 'vulkan', {
        preferDevelopmentBuild: true,
      }),
    ).toBe(local);
    expect(resolveNativeBinaryPath('llama-server', checkoutMainUrl, 'vulkan')).toBe(staged);
  });

  it('skips an incompatible preferred candidate instead of launching it', async () => {
    const key = platformKey();
    if (!key) return;

    const ext = process.platform === 'win32' ? '.exe' : '';
    const checkout = join(tmp, 'checkout');
    const checkoutMain = join(checkout, 'packages', 'app', 'dist', 'main.js');
    const stagedDir = join(checkout, 'packages', 'app', 'native-bin', `${key}-cpu`);
    const localDir = join(checkout, 'native', 'build', `${key}-cpu`);
    await mkdir(join(checkout, 'packages', 'app', 'dist'), { recursive: true });
    await mkdir(stagedDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(checkoutMain, '// stub\n', 'utf8');
    const staged = join(stagedDir, `gezel-llama-server${ext}`);
    const local = join(localDir, `gezel-llama-server${ext}`);
    await writeFile(staged, Buffer.from([0]));
    await writeFile(local, Buffer.from([0]));

    expect(
      resolveNativeBinaryPath('llama-server', pathToFileURL(checkoutMain).href, 'cpu', {
        preferDevelopmentBuild: true,
        accept: (path) => path !== local,
      }),
    ).toBe(staged);
  });
});

describe('verifyLlamaBinaryAgainstCheckoutPin', () => {
  async function checkoutFixture(revision: string): Promise<{ binary: string; mainUrl: string }> {
    const checkout = join(tmp, 'checkout');
    const main = join(checkout, 'packages', 'app', 'dist', 'main.js');
    const binaryDir = join(checkout, 'native', 'build', 'test');
    const pinDir = join(checkout, 'native', 'engines', 'llama-cpp');
    await mkdir(join(checkout, 'packages', 'app', 'dist'), { recursive: true });
    await mkdir(binaryDir, { recursive: true });
    await mkdir(pinDir, { recursive: true });
    await writeFile(main, '// stub\n', 'utf8');
    await writeFile(
      join(pinDir, 'VERSION'),
      'tag=v0.4.0\nbuild=10809\ncommit=5266f24da75dc449bd56cbed7addb9c8e4a6a73e\n',
      'utf8',
    );
    const binary = join(binaryDir, 'gezel-llama-server');
    await writeFile(binary, Buffer.from([0]));
    await writeFile(
      join(binaryDir, 'gezel-llama-build.json'),
      JSON.stringify({ engine: 'llama-cpp', revision }),
      'utf8',
    );
    return { binary, mainUrl: pathToFileURL(main).href };
  }

  it('accepts only a binary and sidecar matching this checkout pin', async () => {
    const { binary, mainUrl } = await checkoutFixture('5266f24da75dc449bd56cbed7addb9c8e4a6a73e');

    const result = verifyLlamaBinaryAgainstCheckoutPin(binary, mainUrl, () => ({
      status: 0,
      stdout: 'version: 0.4.0 (build 10809, commit 5266f24d)\n',
    }));

    expect(result).toMatchObject({
      compatible: true,
      version: '0.4.0',
      build: 10809,
      revision: '5266f24d',
    });
  });

  it('rejects the stale fetched v0.3.0 identity', async () => {
    const { binary, mainUrl } = await checkoutFixture('c1d0e7a004015f23bc0233470b747b596f29b264');

    const result = verifyLlamaBinaryAgainstCheckoutPin(binary, mainUrl, () => ({
      status: 0,
      stdout: 'version: 0.3.0 (build 10621, commit c1d0e7a)\n',
    }));

    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('does not match checkout pin');
  });
});
