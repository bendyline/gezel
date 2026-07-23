import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNativeBinaryPath } from './native-bin.js';

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
});
