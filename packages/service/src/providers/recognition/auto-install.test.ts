import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideAutoInstall } from './auto-install.js';
import { RecognitionManager } from './manager.js';
import { MockRecognitionProvider } from './mock.js';

/**
 * The image reader is pulled automatically alongside a chat model that can't
 * see images. Every case below is one where the download would be waste — the
 * cost of a wrong "yes" is several gigabytes the user never asked for.
 */

let home: string;
const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const CONFIG: GezelConfig = { provider: 'llama-cpp' } as GezelConfig;

/** Nothing installed → a reader would genuinely help. */
const noReader = () => new RecognitionManager({ home, provider: new MockRecognitionProvider() });

const hasReader = () =>
  new RecognitionManager({
    home,
    provider: new MockRecognitionProvider({
      installed: [{ id: 'granite', name: 'Granite', approxSizeBytes: 1, installedAt: 'now' }],
    }),
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-auto-install-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('decideAutoInstall', () => {
  it('installs a reader for a chat model that cannot see', async () => {
    const decision = await decideAutoInstall({
      home,
      config: CONFIG,
      catalogId: 'deepseek-v4-flash-284b-q2',
      recognition: noReader(),
      env: EMPTY_ENV,
    });
    expect(decision?.entry.id).toBe('granite-vision-4.1-4b-q4');
    expect(decision?.reason).toContain('cannot read images');
  });

  it('skips when a reader is already installed', async () => {
    expect(
      await decideAutoInstall({
        home,
        config: CONFIG,
        catalogId: 'deepseek-v4-flash-284b-q2',
        recognition: hasReader(),
        env: EMPTY_ENV,
      }),
    ).toBeNull();
  });

  it('skips when the user turned image scanning off', async () => {
    expect(
      await decideAutoInstall({
        home,
        config: { ...CONFIG, recognition: { mode: 'off' } } as GezelConfig,
        catalogId: 'deepseek-v4-flash-284b-q2',
        recognition: noReader(),
        env: EMPTY_ENV,
      }),
    ).toBeNull();
  });

  it('respects the GEZEL_NO_AUTO_VISION opt-out', async () => {
    expect(
      await decideAutoInstall({
        home,
        config: CONFIG,
        catalogId: 'deepseek-v4-flash-284b-q2',
        recognition: noReader(),
        env: { GEZEL_NO_AUTO_VISION: '1' } as NodeJS.ProcessEnv,
      }),
    ).toBeNull();
  });

  it('skips when the chat model reads images natively', async () => {
    const decision = await decideAutoInstall({
      home,
      config: { ...CONFIG, nativeVision: { 'gemma4-12b-q4': true } } as GezelConfig,
      catalogId: 'gemma4-12b-q4',
      recognition: noReader(),
      // Stands in for the installed-model lookup: projector on disk.
      llamaCppModels: {
        resolveModel: async () => ({ mmprojPath: '/models/mmproj-BF16.gguf' }),
      } as never,
      env: EMPTY_ENV,
    });
    expect(decision).toBeNull();
  });

  // Having the projector on disk isn't enough — if the user hasn't opted in,
  // `--mmproj` never reaches the command line and the model is still blind.
  it('still installs when a projector exists but native vision is off', async () => {
    const decision = await decideAutoInstall({
      home,
      config: CONFIG,
      catalogId: 'gemma4-12b-q4',
      recognition: noReader(),
      llamaCppModels: {
        resolveModel: async () => ({ mmprojPath: '/models/mmproj-BF16.gguf' }),
      } as never,
      env: EMPTY_ENV,
    });
    expect(decision?.entry.id).toBe('granite-vision-4.1-4b-q4');
  });

  it('skips under the mock provider so tests and E2E never pull gigabytes', async () => {
    expect(
      await decideAutoInstall({
        home,
        config: CONFIG,
        catalogId: 'deepseek-v4-flash-284b-q2',
        recognition: noReader(),
        env: { GEZEL_MOCK_PROVIDER: '1' } as NodeJS.ProcessEnv,
      }),
    ).toBeNull();
  });
});
