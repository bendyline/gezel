import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appleFmBinaryPath } from './binary.js';
import { appleFoundationModelsStatus } from './status.js';

describe('Apple model readiness', () => {
  it('does not spawn on unsupported hosts or when the helper is missing', async () => {
    const createHelper = vi.fn();
    expect(
      await appleFoundationModelsStatus({
        platform: 'linux',
        arch: 'arm64',
        env: {},
        createHelper,
      }),
    ).toMatchObject({ supported: false, installed: false, available: false });
    expect(
      await appleFoundationModelsStatus({
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        createHelper,
      }),
    ).toMatchObject({ supported: true, installed: false, available: false });
    expect(createHelper).not.toHaveBeenCalled();
  });

  it('finds headless native payloads and separates presence from actual readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-apple-status-'));
    try {
      await mkdir(join(root, 'darwin-arm64'));
      const binary = join(root, 'darwin-arm64', 'gezel-apple-fm');
      await writeFile(binary, 'fixture');
      const env = { GEZEL_NATIVE_BIN_DIR: root };
      expect(appleFmBinaryPath(env)).toBe(binary);
      expect(appleFmBinaryPath({ ...env, GEZEL_APPLE_FM_BIN: '/explicit' })).toBe('/explicit');
      const helper = {
        ready: vi.fn(async () => ({
          version: '2',
          os: '27',
          contextTokens: 8192,
          maxOutputTokens: 1024,
          available: false,
          reason: 'Model preparing',
        })),
        shutdown: vi.fn(async () => {}),
      };
      const options = {
        env,
        platform: 'darwin' as const,
        arch: 'arm64',
        createHelper: () => helper,
      };
      expect(await appleFoundationModelsStatus(options)).toMatchObject({
        installed: true,
        available: false,
        reason: 'Model preparing',
      });
      helper.ready.mockRejectedValueOnce(new Error('Helper failed'));
      expect(await appleFoundationModelsStatus(options)).toMatchObject({
        installed: true,
        available: false,
        reason: 'Helper failed',
      });
      expect(helper.shutdown).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
