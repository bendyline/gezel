import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelStorageRoots } from '@bendyline/gezel-inference/internal/models/storage-roots';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectWhisperModel, whisperRunsOnGpu } from './stt-factory.js';

let modelsRoot: string;
let storageRoots: ModelStorageRoots;

beforeEach(async () => {
  modelsRoot = await mkdtemp(join(tmpdir(), 'gezel-stt-factory-'));
  storageRoots = { writableRoot: modelsRoot, readOnlyRoots: [] };
});

afterEach(async () => {
  await rm(modelsRoot, { recursive: true, force: true });
});

async function installModel(id: string, name: string) {
  await mkdir(join(modelsRoot, id), { recursive: true });
  await writeFile(join(modelsRoot, id, `${id}.bin`), 'weights', 'utf8');
  await writeFile(
    join(modelsRoot, id, 'manifest.json'),
    JSON.stringify({
      id,
      name,
      files: [{ role: 'weights', filename: `${id}.bin` }],
    }),
    'utf8',
  );
}

describe('selectWhisperModel', () => {
  it('picks the first installed model by id when nothing is configured', async () => {
    await installModel('whisper-base.en', 'Base');
    await installModel('whisper-small.en', 'Small');

    const model = await selectWhisperModel(storageRoots);
    expect(model?.id).toBe('whisper-base.en');
  });

  it('picks the configured default when it is installed', async () => {
    await installModel('whisper-base.en', 'Base');
    await installModel('whisper-small.en', 'Small');

    const model = await selectWhisperModel(storageRoots, 'whisper-small.en');
    expect(model?.id).toBe('whisper-small.en');
    expect(model?.weightsPath).toBe(join(modelsRoot, 'whisper-small.en', 'whisper-small.en.bin'));
  });

  it('falls back to the first installed model when the configured default is gone', async () => {
    await installModel('whisper-base.en', 'Base');

    const model = await selectWhisperModel(storageRoots, 'whisper-small.en');
    expect(model?.id).toBe('whisper-base.en');
  });

  it('returns undefined when nothing is installed', async () => {
    expect(await selectWhisperModel(storageRoots, 'whisper-small.en')).toBeUndefined();
  });
});

describe('whisperRunsOnGpu', () => {
  it('charges the card only for builds that use it', () => {
    const cuda = 'C:\\Gezel\\native-bin\\win32-arm64-cuda\\gezel-whisper-server.exe';
    const cpu = 'C:\\Gezel\\native-bin\\win32-arm64\\gezel-whisper-server.exe';
    expect(whisperRunsOnGpu(cuda, 'win32')).toBe(true);
    expect(whisperRunsOnGpu(cpu, 'win32')).toBe(false);
    expect(whisperRunsOnGpu('/opt/gezel/native-bin/linux-x64/gezel-whisper-server', 'linux')).toBe(
      false,
    );
    // Metal shares the Mac's memory with the GPU.
    expect(
      whisperRunsOnGpu(
        '/Applications/Gezel.app/native-bin/darwin-arm64/gezel-whisper-server',
        'darwin',
      ),
    ).toBe(true);
  });
});
