import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { UvRuntime } from '../python/uv-runtime.js';
import { createRemotesRegistry } from '../remotes/registry.js';
import { MockSpeechToTextProvider } from './audio/mock-stt.js';
import { MockTextToSpeechProvider } from './audio/mock-tts.js';
import { SpeechToTextProviderManager, usesMachineSpeechToText } from './audio/stt-manager.js';
import { TextToSpeechProviderManager, usesMachineTextToSpeech } from './audio/tts-manager.js';
import { VideoProviderManager, usesMachineVideo } from './video/manager.js';
import { MockVideoProvider } from './video/mock.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function homeWithMachineRemote(): Promise<{
  home: string;
  remotes: Awaited<ReturnType<typeof createRemotesRegistry>>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-media-routing-'));
  homes.push(home);
  const remotes = await createRemotesRegistry({ home });
  remotes.setEphemeral({
    remoteId: 'this-machine',
    baseUrl: 'https://127.0.0.1:6228',
    displayName: 'This machine',
    token: 'machine-token',
    pinnedIdentityKey: 'test-key',
    pinnedIdentityFingerprint: 'test-fingerprint',
    scopes: ['remote-inference', 'machine-models'],
    pairedAt: Date.now(),
    managed: 'machine-engine',
  });
  return { home, remotes };
}

describe('media machine-broker routing policy', () => {
  it('keeps mock audio and video providers in the user daemon', () => {
    const env = { GEZEL_MOCK_PROVIDER: '1' };
    expect(usesMachineSpeechToText(env)).toBe(false);
    expect(usesMachineTextToSpeech(env)).toBe(false);
    expect(usesMachineVideo({}, env)).toBe(false);
  });

  it('keeps explicitly hosted whisper and video servers in the user daemon', () => {
    expect(usesMachineSpeechToText({ GEZEL_WHISPER_SERVER_URL: 'http://127.0.0.1:9000' })).toBe(
      false,
    );
    expect(usesMachineVideo({}, { GEZEL_VIDEO_SERVER_URL: 'http://127.0.0.1:9001' })).toBe(false);
  });

  it('routes default native media providers to the shared broker', () => {
    expect(usesMachineSpeechToText({})).toBe(true);
    expect(usesMachineTextToSpeech({})).toBe(true);
    expect(usesMachineVideo({}, {})).toBe(true);
  });

  it('honors mock providers through the real manager entry points', async () => {
    const { home, remotes } = await homeWithMachineRemote();
    const stt = new SpeechToTextProviderManager({ home, env: { GEZEL_MOCK_PROVIDER: '1' } });
    stt.setRemotes(remotes);
    stt.setMachineEngineRemoteResolver(() => 'this-machine');
    await expect(stt.providerForModel(undefined)).resolves.toBeInstanceOf(MockSpeechToTextProvider);

    const tts = new TextToSpeechProviderManager({ home, env: { GEZEL_MOCK_PROVIDER: '1' } });
    tts.setRemotes(remotes);
    tts.setMachineEngineRemoteResolver(() => 'this-machine');
    await expect(tts.providerForModel(undefined)).resolves.toBeInstanceOf(MockTextToSpeechProvider);

    const store = new Store({ home });
    await store.ensureLayout();
    const video = new VideoProviderManager({
      home,
      store,
      catalog: new CatalogService(),
      uvRuntime: {} as UvRuntime,
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    video.setRemotes(remotes);
    video.setMachineEngineRemoteResolver(() => 'this-machine');
    await expect(video.providerForModel(undefined)).resolves.toBeInstanceOf(MockVideoProvider);

    await Promise.all([
      stt.retireLocalForMachineBroker(),
      tts.retireLocalForMachineBroker(),
      video.retireLocalForMachineBroker(),
    ]);
    await expect(stt.current()).resolves.toBeInstanceOf(MockSpeechToTextProvider);
    await expect(tts.current()).resolves.toBeInstanceOf(MockTextToSpeechProvider);
    await expect(video.current()).resolves.toBeInstanceOf(MockVideoProvider);
  });
});
