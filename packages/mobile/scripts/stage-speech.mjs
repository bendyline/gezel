import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifySpeech } from '../../capacitor/scripts/stage-native.mjs';
import { replaceNativeAssets } from './stage-native-assets.mjs';

/** The speech runtime the app links: @bendyline/gezel-capacitor's, as for any app. */
export async function appSpeechRuntime(repo, platform) {
  try {
    return await verifySpeech(
      path.join(repo, 'packages/capacitor/native', `speech-${platform}`),
      platform,
    );
  } catch {
    throw new Error(
      `Run pnpm mobile:build:speech ${platform} to stage the speech runtime the app links.`,
    );
  }
}

export async function speechPayload(repo, platform) {
  const root = path.join(repo, 'native/mobile/.build', `speech-${platform}`, 'payload');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'speech-build.json'), 'utf8'));
  } catch {
    throw new Error(`Run pnpm mobile:build:speech ${platform} before syncing speech.`);
  }
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const pins = JSON.parse(
    await readFile(path.join(repo, 'native/mobile/speech/pins.json'), 'utf8'),
  );
  if (JSON.stringify(pins) !== JSON.stringify(manifest.pins))
    throw new Error('Rebuild speech after changing dependency pins.');
  for (const [name, expected] of Object.entries(manifest.bridge)) {
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      digest(await readFile(path.join(repo, 'native/mobile/speech', name))) !== expected
    )
      throw new Error('Rebuild speech after changing the native bridge.');
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      digest(await readFile(path.join(root, name))) !== expected
    )
      throw new Error('Speech build verification failed.');
  }
  if (
    !manifest.files['models/whisper-tiny.bin'] ||
    !manifest.files['models/kokoro/model.int8.onnx']
  )
    throw new Error(
      `This speech build has no offline speech pack; rebuild it with pnpm mobile:build:speech ${platform}.`,
    );
  return { root, manifest };
}

export async function stageSpeech(repo, mobile, platform) {
  const payload = await speechPayload(repo, platform);
  const destination =
    platform === 'android'
      ? path.join(mobile, 'android/app/src/main/assets/speech')
      : path.join(mobile, '.build/speech/assets/speech');
  const voices = await readFile(path.join(repo, 'native/mobile/speech/voices.json'));
  const files = Object.entries(payload.manifest.files).filter(([name]) =>
    name.startsWith('models/'),
  );
  await replaceNativeAssets([
    {
      target: destination,
      files: files.map(([name, sha256]) => ({
        relative: name.slice('models/'.length),
        source: path.join(payload.root, name),
        sha256,
      })),
    },
  ]);
  await writeFile(path.join(destination, 'voices.json'), voices);
  const inventory = Object.fromEntries(
    files.map(([name, sha256]) => [name.slice('models/'.length), sha256]),
  );
  inventory['voices.json'] = createHash('sha256').update(voices).digest('hex');
  const sizes = await Promise.all(
    files.map(async ([name]) => [name, (await stat(path.join(payload.root, name))).size]),
  );
  const pack = JSON.stringify({
    stt: [
      {
        id: 'whisper-tiny',
        name: 'Whisper tiny',
        approxSizeBytes: sizes.find(([name]) => name === 'models/whisper-tiny.bin')[1],
      },
    ],
    tts: [
      {
        id: 'kokoro-82m-v1.0',
        name: 'Kokoro v1.0',
        approxSizeBytes: sizes
          .filter(([name]) => name.startsWith('models/kokoro/'))
          .reduce((total, [, size]) => total + size, 0),
      },
    ],
  });
  await writeFile(path.join(destination, 'pack.json'), pack);
  inventory['pack.json'] = createHash('sha256').update(pack).digest('hex');
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(inventory));
  return payload;
}
