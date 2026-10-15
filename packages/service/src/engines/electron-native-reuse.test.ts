import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ElectronNativeReuseOptions,
  reuseVerifiedElectronNativeBinaries,
  verifyNativeBinaries,
} from '@bendyline/gezel-inference/internal/engines/electron-native-reuse';
import type { VerifyOptions } from '@bendyline/gezel-inference/internal/engines/signature';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
const originalNativeRoot = process.env.GEZEL_NATIVE_BIN_DIR;

afterEach(async () => {
  if (originalNativeRoot === undefined) delete process.env.GEZEL_NATIVE_BIN_DIR;
  else process.env.GEZEL_NATIVE_BIN_DIR = originalNativeRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Electron native reuse', () => {
  it('adopts a fully pinned payload without re-checking file signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-'));
    roots.push(root);
    const dir = join(root, 'win32-x64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('signed executable fixture');
    await writeFile(join(dir, 'gezel-device-health.exe'), bytes);
    const verifySignature = vi.fn(async (_path: string, _opts: VerifyOptions) => ({
      accepted: true,
      result: { status: 'valid' as const, detail: 'Bendyline LLC' },
    }));

    const result = await reuseVerifiedElectronNativeBinaries({
      candidates: [root],
      platform: 'win32',
      arch: 'x64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'win32-x64': {
            files: {
              'gezel-device-health.exe': {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature,
    });

    expect(result.reused).toBe(true);
    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe(root);
    // The pins are the per-file check; the release verified these signatures.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('pure verifier: adopts a fully pinned payload without re-checking file signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-'));
    roots.push(root);
    const dir = join(root, 'win32-x64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('signed executable fixture');
    await writeFile(join(dir, 'gezel-device-health.exe'), bytes);
    const verifySignature = vi.fn(async (_path: string, _opts: VerifyOptions) => ({
      accepted: true,
      result: { status: 'valid' as const, detail: 'Bendyline LLC' },
    }));

    const result = await verifyNativeBinaries({
      candidates: [root],
      platform: 'win32',
      arch: 'x64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'win32-x64': {
            files: {
              'gezel-device-health.exe': {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature,
    });

    expect(result.reused).toBe(true);
    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe(originalNativeRoot);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('rejects a pinned file whose bytes changed, whatever its signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-'));
    roots.push(root);
    const dir = join(root, 'win32-x64');
    await mkdir(dir, { recursive: true });
    const pinned = Buffer.from('signed executable fixture');
    // Same size, different bytes: only the hash can tell them apart.
    const replaced = Buffer.from('signed executable fixturE');
    await writeFile(join(dir, 'gezel-device-health.exe'), replaced);
    const verifySignature = vi.fn(async (_path: string, _opts: VerifyOptions) => ({
      accepted: true,
      result: { status: 'valid' as const, detail: 'Bendyline LLC' },
    }));

    const result = await verifyNativeBinaries({
      candidates: [root],
      platform: 'win32',
      arch: 'x64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'win32-x64': {
            files: {
              'gezel-device-health.exe': {
                sha256: createHash('sha256').update(pinned).digest('hex'),
                sizeBytes: pinned.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature,
    });

    expect(result.reused).toBe(false);
    expect(result.reason).toContain('sha256 mismatch: win32-x64/gezel-device-health.exe');
  });

  it('rejects an unpinned loadable DLL even when pinned files match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-'));
    roots.push(root);
    const dir = join(root, 'win32-x64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('fixture');
    await writeFile(join(dir, 'gezel-device-health.exe'), bytes);
    await writeFile(join(dir, 'injected.dll'), 'not pinned');

    const result = await reuseVerifiedElectronNativeBinaries({
      candidates: [root],
      platform: 'win32',
      arch: 'x64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'win32-x64': {
            files: {
              'gezel-device-health.exe': {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature: vi.fn(async () => ({
        accepted: true,
        result: { status: 'valid' as const },
      })),
    });

    expect(result.reused).toBe(false);
    expect(result.reason).toContain('executable/loadable file set mismatch');
    expect(result.reason).toContain('unexpected: injected.dll');
  });

  describe('with a verification cache', () => {
    const bytes = Buffer.from('signed executable fixture');

    async function cachedPayload(cacheFile?: string) {
      const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-'));
      roots.push(root);
      const dir = join(root, 'win32-x64');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'gezel-device-health.exe'), bytes);
      const options: ElectronNativeReuseOptions = {
        candidates: [root],
        platform: 'win32',
        arch: 'x64',
        release: '9.9.9',
        manifest: {
          schemaVersion: 2,
          release: '9.9.9',
          platforms: {
            'win32-x64': {
              files: {
                'gezel-device-health.exe': {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  sizeBytes: bytes.length,
                  signature: 'bendyline',
                },
              },
              symlinks: {},
            },
          },
        },
        cacheFile: cacheFile ?? join(root, 'home', 'engines', 'native-payload', 'verified.json'),
      };
      return { dir, options };
    }

    it('keeps what a separate call verified against the same cache', async () => {
      // A dev launch checks the checkout's payload and the installed app's in
      // two calls; neither may erase the other's records.
      const checkout = await cachedPayload();
      const installed = await cachedPayload(checkout.options.cacheFile);
      await verifyNativeBinaries(checkout.options);
      await verifyNativeBinaries(installed.options);

      expect((await verifyNativeBinaries(checkout.options)).reason).toContain(
        '(0 of 1 files hashed)',
      );
      expect((await verifyNativeBinaries(installed.options)).reason).toContain(
        '(0 of 1 files hashed)',
      );
    });

    it('does not hash an unchanged payload again', async () => {
      const { options } = await cachedPayload();
      const first = await verifyNativeBinaries(options);
      expect(first).toMatchObject({ reused: true });
      expect(first.reason).toContain('(1 of 1 files hashed)');

      const second = await verifyNativeBinaries(options);
      expect(second).toMatchObject({ reused: true });
      expect(second.reason).toContain('(0 of 1 files hashed)');
    });

    it('hashes a file again once it is edited, and rejects bytes that changed', async () => {
      const { dir, options } = await cachedPayload();
      await verifyNativeBinaries(options);
      // Past one clock tick, so the edit's file times differ from the first pass.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(
        join(dir, 'gezel-device-health.exe'),
        Buffer.from('signed executable fixturE'),
      );

      const result = await verifyNativeBinaries(options);
      expect(result.reused).toBe(false);
      expect(result.reason).toContain('sha256 mismatch: win32-x64/gezel-device-health.exe');
    });

    it('still rejects an unpinned DLL planted beside a cached payload', async () => {
      const { dir, options } = await cachedPayload();
      await verifyNativeBinaries(options);
      await writeFile(join(dir, 'injected.dll'), 'not pinned');

      const result = await verifyNativeBinaries(options);
      expect(result.reused).toBe(false);
      expect(result.reason).toContain('unexpected: injected.dll');
    });

    it('verifies in full when the cache is unreadable', async () => {
      const { options } = await cachedPayload();
      await verifyNativeBinaries(options);
      await writeFile(options.cacheFile!, '{ not json');

      const result = await verifyNativeBinaries(options);
      expect(result.reason).toContain('(1 of 1 files hashed)');
    });
  });

  it('assesses the signed parent app, never a bare native file, for notarization', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'gezel-electron-app-'));
    roots.push(temp);
    const root = join(
      temp,
      'Gezel.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'native-bin',
    );
    const dir = join(root, 'darwin-arm64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('signed dylib fixture');
    await writeFile(join(dir, 'libgezel-fixture.dylib'), bytes);
    const verifySignature = vi.fn(async (_path: string, _opts: VerifyOptions) => ({
      accepted: true,
      result: { status: 'valid' as const, detail: 'Bendyline LLC' },
    }));

    const result = await reuseVerifiedElectronNativeBinaries({
      candidates: [root],
      platform: 'darwin',
      arch: 'arm64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'darwin-arm64': {
            files: {
              'libgezel-fixture.dylib': {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature,
    });

    expect(result.reused).toBe(true);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(verifySignature.mock.calls[0]?.[0]).toMatch(/Gezel\.app$/);
    expect(verifySignature.mock.calls[0]?.[1]).toMatchObject({
      requireNotarizedApp: true,
    });
  });

  it('requires explicit opt-in for an exactly pinned standalone macOS release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-standalone-native-'));
    roots.push(root);
    const dir = join(root, 'darwin-arm64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('signed standalone fixture');
    // Windows does not preserve POSIX executable bits. Use a dylib suffix
    // there so the simulated macOS payload is still classified as loadable.
    const fixtureName =
      process.platform === 'win32' ? 'libgezel-fixture.dylib' : 'gezel-ds4-server';
    await writeFile(join(dir, fixtureName), bytes, { mode: 0o755 });
    const verifySignature = vi.fn(async (_path: string, _opts: VerifyOptions) => ({
      accepted: true,
      result: { status: 'valid' as const, detail: 'Bendyline LLC' },
    }));

    const options: ElectronNativeReuseOptions = {
      candidates: [root],
      platform: 'darwin',
      arch: 'arm64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'darwin-arm64': {
            files: {
              [fixtureName]: {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'bendyline',
              },
            },
            symlinks: {},
          },
        },
      },
      verifySignature,
    };

    const rejected = await reuseVerifiedElectronNativeBinaries(options);
    expect(rejected.reused).toBe(false);
    expect(rejected.reason).toContain('native payload is not inside a macOS app bundle');

    verifySignature.mockClear();
    const result = await reuseVerifiedElectronNativeBinaries({
      ...options,
      allowStandaloneMacPayload: true,
    });

    expect(result.reused).toBe(true);
    expect(result.nativeBinDir).toBe(root);
    // A standalone tree has no enclosing app to assess, and its pins are the file check.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')(
    'accepts an exactly pinned internal SONAME symlink chain',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-links-'));
      roots.push(root);
      const dir = join(root, 'linux-x64');
      await mkdir(dir, { recursive: true });
      const bytes = Buffer.from('shared library fixture');
      await writeFile(join(dir, 'libgezel.so.1.2.3'), bytes);
      await symlink('libgezel.so.1.2.3', join(dir, 'libgezel.so.1'));
      await symlink('libgezel.so.1', join(dir, 'libgezel.so'));

      const result = await reuseVerifiedElectronNativeBinaries({
        candidates: [root],
        platform: 'linux',
        arch: 'x64',
        release: '9.9.9',
        manifest: {
          schemaVersion: 2,
          release: '9.9.9',
          platforms: {
            'linux-x64': {
              files: {
                'libgezel.so.1.2.3': {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  sizeBytes: bytes.length,
                  signature: 'hash-only',
                },
              },
              symlinks: {
                'libgezel.so': 'libgezel.so.1',
                'libgezel.so.1': 'libgezel.so.1.2.3',
              },
            },
          },
        },
      });

      expect(result.reused).toBe(true);
      expect(result.nativeBinDir).toBe(root);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an unpinned symlink even when it resolves to a pinned file',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-links-'));
      roots.push(root);
      const dir = join(root, 'linux-x64');
      await mkdir(dir, { recursive: true });
      const bytes = Buffer.from('shared library fixture');
      await writeFile(join(dir, 'libgezel.so.1'), bytes);
      await symlink('libgezel.so.1', join(dir, 'libgezel.so'));

      const result = await reuseVerifiedElectronNativeBinaries({
        candidates: [root],
        platform: 'linux',
        arch: 'x64',
        release: '9.9.9',
        manifest: {
          schemaVersion: 2,
          release: '9.9.9',
          platforms: {
            'linux-x64': {
              files: {
                'libgezel.so.1': {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  sizeBytes: bytes.length,
                  signature: 'hash-only',
                },
              },
              symlinks: {},
            },
          },
        },
      });

      expect(result.reused).toBe(false);
      expect(result.reason).toContain('symlink set mismatch');
      expect(result.reason).toContain('unexpected: libgezel.so');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects pinned symlinks with escaping targets',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-links-'));
      roots.push(root);
      const dir = join(root, 'linux-x64');
      await mkdir(dir, { recursive: true });
      const bytes = Buffer.from('shared library fixture');
      await writeFile(join(dir, 'libgezel.so.1'), bytes);
      await symlink('../outside.so', join(dir, 'libgezel.so'));

      const result = await reuseVerifiedElectronNativeBinaries({
        candidates: [root],
        platform: 'linux',
        arch: 'x64',
        release: '9.9.9',
        manifest: {
          schemaVersion: 2,
          release: '9.9.9',
          platforms: {
            'linux-x64': {
              files: {
                'libgezel.so.1': {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  sizeBytes: bytes.length,
                  signature: 'hash-only',
                },
              },
              symlinks: {
                'libgezel.so': '../outside.so',
              },
            },
          },
        },
      });

      expect(result.reused).toBe(false);
      expect(result.reason).toContain('unsafe symlink target');
    },
  );

  it.runIf(process.platform !== 'win32')('rejects pinned symlink cycles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-electron-native-links-'));
    roots.push(root);
    const dir = join(root, 'linux-x64');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('shared library fixture');
    await writeFile(join(dir, 'libgezel-real.so'), bytes);
    await symlink('libgezel-b.so', join(dir, 'libgezel-a.so'));
    await symlink('libgezel-a.so', join(dir, 'libgezel-b.so'));

    const result = await reuseVerifiedElectronNativeBinaries({
      candidates: [root],
      platform: 'linux',
      arch: 'x64',
      release: '9.9.9',
      manifest: {
        schemaVersion: 2,
        release: '9.9.9',
        platforms: {
          'linux-x64': {
            files: {
              'libgezel-real.so': {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.length,
                signature: 'hash-only',
              },
            },
            symlinks: {
              'libgezel-a.so': 'libgezel-b.so',
              'libgezel-b.so': 'libgezel-a.so',
            },
          },
        },
      },
    });

    expect(result.reused).toBe(false);
    expect(result.reason).toContain('symlink cycle');
  });
});
