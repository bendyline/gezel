import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenerationOutput } from '../providers/video/types.js';
import { type RunningService, startService } from '../service.js';

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe('late machine-engine adoption', () => {
  it('retries a failed drain, preserves cloud-equivalent image config, and waits for active media', async () => {
    const priorMock = process.env.GEZEL_MOCK_PROVIDER;
    const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;
    process.env.GEZEL_MOCK_PROVIDER = '1';
    process.env.GEZEL_SECRETS_BACKEND = 'file';
    const machineHome = await mkdtemp(join(tmpdir(), 'gezel-late-engine-'));
    const userHome = await mkdtemp(join(tmpdir(), 'gezel-late-user-'));
    let machine: RunningService | undefined;
    let user: RunningService | undefined;
    let releaseGeneration: (() => void) | undefined;
    try {
      user = await startService({ home: userHome, role: 'user', machineEngineHome: machineHome });
      expect(user.context.machineEngine?.isConnected()).toBe(false);

      const [image, video, stt, tts] = await Promise.all([
        user.context.imageProvider.current(),
        user.context.videoProvider.current(),
        user.context.stt.current(),
        user.context.tts.current(),
      ]);
      const imageShutdown = vi.fn(async () => {});
      const videoShutdown = vi.fn(async () => {});
      const sttShutdown = vi.fn(async () => {});
      const ttsShutdown = vi.fn(async () => {});
      image.shutdown = imageShutdown;
      video.shutdown = videoShutdown;
      stt.shutdown = sttShutdown;
      tts.shutdown = ttsShutdown;

      const generationGate = new Promise<void>((resolve) => {
        releaseGeneration = resolve;
      });
      video.generate = async () => {
        await generationGate;
        return {} as VideoGenerationOutput;
      };
      const generation = video.generate({ prompt: 'finish this local render' });

      const originalRetire = user.context.videoProvider.retireLocalForMachineBroker.bind(
        user.context.videoProvider,
      );
      let retireAttempts = 0;
      user.context.videoProvider.retireLocalForMachineBroker = async () => {
        retireAttempts += 1;
        if (retireAttempts === 1) throw new Error('injected first-adoption failure');
        await originalRetire();
      };

      machine = await startService({ home: machineHome, role: 'machine-engine' });
      await waitFor(() => retireAttempts >= 2);

      expect(user.context.machineEngine?.isConnected()).toBe(true);
      expect(videoShutdown).not.toHaveBeenCalled();
      expect(imageShutdown).not.toHaveBeenCalled();

      releaseGeneration?.();
      await generation;
      await waitFor(() => videoShutdown.mock.calls.length === 1);

      expect(sttShutdown).toHaveBeenCalledTimes(1);
      expect(ttsShutdown).toHaveBeenCalledTimes(1);
      expect(imageShutdown).not.toHaveBeenCalled();
      await expect(user.context.imageProvider.current()).resolves.toMatchObject({ name: 'mock' });
      await expect(user.context.videoProvider.current()).resolves.toMatchObject({
        name: 'remote:This machine',
      });
      await expect(user.context.stt.current()).resolves.toMatchObject({
        name: 'remote:This machine',
      });
      await expect(user.context.tts.current()).resolves.toMatchObject({
        name: 'remote:This machine',
      });
    } finally {
      releaseGeneration?.();
      await user?.stop().catch(() => undefined);
      await machine?.stop().catch(() => undefined);
      await Promise.all([
        rm(userHome, { recursive: true, force: true }).catch(() => undefined),
        rm(machineHome, { recursive: true, force: true }).catch(() => undefined),
      ]);
      if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
      else process.env.GEZEL_MOCK_PROVIDER = priorMock;
      if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
      else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
    }
  }, 40_000);
});
