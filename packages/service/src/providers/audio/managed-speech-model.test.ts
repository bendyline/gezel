import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KOKORO_TRANSFORMERS_FILES,
  KOKORO_TRANSFORMERS_METADATA,
  SpeechAssetStore,
  type SpeechModelEntry,
} from '@bendyline/gezel/speech-models';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  ensureSpeechModel,
  sharedSpeechModelInfo,
  speechPullEvents,
} from './managed-speech-model.js';

const bytes = Buffer.from('verified model');
const file = {
  name: 'weights.bin',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  url: 'https://model.test/weights',
};
const entry: SpeechModelEntry = {
  id: 'whisper-test',
  kind: 'stt',
  label: 'Test',
  description: '',
  recommended: true,
  license: 'MIT',
  licenseUrl: 'https://model.test/license',
  files: [file],
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-managed-speech-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('discovers an embedder-first install without network and publishes the native launcher manifest only on use', async () => {
  let downloads = 0;
  const assets = new SpeechAssetStore({
    root: join(root, 'cache'),
    fetchImpl: (async () => {
      downloads++;
      return new Response(bytes);
    }) as typeof fetch,
  });
  const docblocks = join(root, 'docblocks', file.name);
  const gezel = join(root, 'gezel');
  expect(await sharedSpeechModelInfo(assets, entry, gezel)).toBeNull();
  expect(downloads).toBe(0);
  await assets.materialize(entry, file, docblocks, { download: true });
  expect(await sharedSpeechModelInfo(assets, entry, gezel)).toMatchObject({ id: entry.id });
  await expect(stat(gezel)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await ensureSpeechModel(assets, entry, gezel, false)).toBe(true);
  const directory = join(gezel, entry.id);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  expect(manifest.files).toEqual([
    { role: 'weights', filename: 'weights.bin', sha256: file.sha256 },
  ]);
  expect(manifest.fileSha256).toEqual({ 'weights.bin': file.sha256 });
  await rm(docblocks);
  await assets.collect(file);
  expect(await readFile(join(directory, file.name))).toEqual(bytes);
  expect(downloads).toBe(1);
});

it('rejects a corrupt candidate and only a pull can replace it', async () => {
  const legacy = join(root, 'legacy.bin');
  await writeFile(legacy, Buffer.alloc(bytes.length));
  let downloads = 0;
  const assets = new SpeechAssetStore({
    root: join(root, 'cache'),
    candidates: () => [legacy],
    fetchImpl: (async () => {
      downloads++;
      return new Response(bytes);
    }) as typeof fetch,
  });
  expect(await ensureSpeechModel(assets, entry, join(root, 'app'), false)).toBe(false);
  expect(downloads).toBe(0);
  const events = [];
  for await (const event of speechPullEvents(entry.id, (progress) =>
    ensureSpeechModel(assets, entry, join(root, 'app'), true, progress),
  ))
    events.push(event);
  expect(events.at(-1)).toEqual({ type: 'done', id: entry.id });
  expect(events.some((event) => event.type === 'progress')).toBe(true);
  expect(downloads).toBe(1);
});

it('ships the exact pinned tokenizer metadata so using a DocBlocks model never fetches metadata', () => {
  for (const file of KOKORO_TRANSFORMERS_FILES) {
    const bytes = Buffer.from(KOKORO_TRANSFORMERS_METADATA[file.name]!);
    expect(bytes.length).toBe(file.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
});
