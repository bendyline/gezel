import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { speechPayload, stageSpeech } from './stage-speech.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(run) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gezel-speech-stage-'));
  const source = path.join(repo, 'native/mobile/speech');
  const root = path.join(repo, 'native/mobile/.build/speech-android/payload');
  const mobile = path.join(repo, 'packages/mobile');
  try {
    await mkdir(source, { recursive: true });
    await mkdir(path.join(root, 'models/kokoro'), { recursive: true });
    await writeFile(path.join(source, 'pins.json'), '{}');
    await writeFile(path.join(source, 'gezel_speech.cpp'), 'current bridge');
    await writeFile(path.join(source, 'voices.json'), '[]');
    const files = {};
    for (const [name, value] of Object.entries({
      'models/whisper-tiny.bin': 'whisper',
      'models/kokoro/model.int8.onnx': 'kokoro',
    })) {
      await writeFile(path.join(root, name), value);
      files[name] = hash(value);
    }
    const manifest = { pins: {}, bridge: { 'gezel_speech.cpp': hash('current bridge') }, files };
    await writeFile(path.join(root, 'speech-build.json'), JSON.stringify(manifest));
    await run({ repo, source, root, mobile, manifest });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
test('stages a verifiable offline pack with measured model sizes', () =>
  fixture(async ({ repo, mobile }) => {
    await stageSpeech(repo, mobile, 'android');
    const destination = path.join(mobile, 'android/app/src/main/assets/speech');
    const pack = JSON.parse(await readFile(path.join(destination, 'pack.json'), 'utf8'));
    assert.equal(pack.stt[0].approxSizeBytes, 7);
    assert.equal(pack.tts[0].approxSizeBytes, 6);
    const inventory = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
    for (const [name, expected] of Object.entries(inventory))
      assert.equal(hash(await readFile(path.join(destination, name))), expected);
  }));
test('rejects stale native source before staging models', () =>
  fixture(async ({ repo, source }) => {
    await writeFile(path.join(source, 'gezel_speech.cpp'), 'changed bridge');
    await assert.rejects(speechPayload(repo, 'android'), /Rebuild speech/);
  }));
test('rejects altered model bytes', () =>
  fixture(async ({ repo, root }) => {
    await writeFile(path.join(root, 'models/whisper-tiny.bin'), 'corrupted');
    await assert.rejects(speechPayload(repo, 'android'), /verification failed/);
  }));
test('rejects a manifest path outside the speech payload', () =>
  fixture(async ({ repo, root, manifest }) => {
    manifest.files['../outside'] = hash('outside');
    await writeFile(path.join(root, 'speech-build.json'), JSON.stringify(manifest));
    await assert.rejects(speechPayload(repo, 'android'), /verification failed/);
  }));
