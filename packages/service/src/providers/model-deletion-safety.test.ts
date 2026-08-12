import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KokoroProvider } from './audio/kokoro.js';
import { MockSpeechToTextProvider } from './audio/mock-stt.js';
import { MockTextToSpeechProvider } from './audio/mock-tts.js';
import { WhisperCppProvider } from './audio/whisper-cpp.js';
import { StableDiffusionCppProvider } from './image/sd-cpp.js';
import { LlamaVisionProvider } from './recognition/llama-vision.js';

interface ModelDeleter {
  deleteModel(id: string): Promise<void>;
}

type ProviderFactory = (modelsRoot: string) => ModelDeleter;

const PROVIDERS: ReadonlyArray<readonly [string, ProviderFactory]> = [
  [
    'stable-diffusion.cpp',
    (modelsRoot) =>
      new StableDiffusionCppProvider({
        baseUrl: 'http://127.0.0.1:1',
        modelsRoot,
        configured: false,
      }),
  ],
  [
    'whisper.cpp',
    (modelsRoot) =>
      new WhisperCppProvider({
        baseUrl: 'http://127.0.0.1:1',
        modelsRoot,
        configured: false,
      }),
  ],
  ['Kokoro', (modelsRoot) => new KokoroProvider({ modelsRoot })],
  ['mock speech-to-text', (modelsRoot) => new MockSpeechToTextProvider({ modelsRoot })],
  ['mock text-to-speech', (modelsRoot) => new MockTextToSpeechProvider({ modelsRoot })],
  [
    'llama.cpp recognition',
    (modelsRoot) =>
      new LlamaVisionProvider({
        baseUrl: 'http://127.0.0.1:1',
        modelsRoot,
        configured: false,
      }),
  ],
];

let fixtureRoot: string;
let modelsRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'gezel-model-delete-safety-'));
  modelsRoot = join(fixtureRoot, 'models');
  await mkdir(modelsRoot);
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe.each(PROVIDERS)('%s model deletion', (_name, createProvider) => {
  it('rejects traversal before touching a sibling directory', async () => {
    const outsideFile = join(fixtureRoot, 'outside', 'keep.txt');
    await mkdir(join(fixtureRoot, 'outside'));
    await writeFile(outsideFile, 'keep', 'utf8');

    await expect(createProvider(modelsRoot).deleteModel('../outside')).rejects.toMatchObject({
      code: 'invalid-model-id',
    });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep');
  });

  it('still deletes a valid model directory without touching its sibling', async () => {
    const modelDir = join(modelsRoot, 'safe-model');
    const siblingFile = join(fixtureRoot, 'outside', 'keep.txt');
    await mkdir(modelDir);
    await mkdir(join(fixtureRoot, 'outside'));
    await writeFile(join(modelDir, 'manifest.json'), '{}', 'utf8');
    await writeFile(siblingFile, 'keep', 'utf8');

    await createProvider(modelsRoot).deleteModel('safe-model');

    await expect(access(modelDir)).rejects.toBeDefined();
    await expect(readFile(siblingFile, 'utf8')).resolves.toBe('keep');
  });
});
