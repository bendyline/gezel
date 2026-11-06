import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SPEECH_ABI,
  stageNative,
  stageSpeech,
  verifyProducerSources,
  verifyRuntime,
} from './stage-native.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gezel-capacitor-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    scope: 'provider-model-runtime',
    target: 'ios',
    packageVersion: '0.1.0-local.1',
    gezelABIVersion: 1,
    files: { 'runtime.bin': sha('verified') },
  };
  await writeFile(path.join(root, 'runtime.bin'), 'verified');
  const save = () => writeFile(path.join(root, 'sdk-manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

test('stages only verified bytes and preserves the last package on a bad update', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'installed');
  await writeFile(path.join(f.root, 'undeclared.bin'), 'stale');
  await stageNative('ios', f.root, destination);
  await assert.rejects(readFile(path.join(destination, 'undeclared.bin')), { code: 'ENOENT' });
  await writeFile(path.join(f.root, 'runtime.bin'), 'altered');
  await assert.rejects(stageNative('ios', f.root, destination), /integrity/);
  assert.equal(await readFile(path.join(destination, 'runtime.bin'), 'utf8'), 'verified');
});

test("stages a speech runtime only with its own scope and the plugins' ABI", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'speech');
  await assert.rejects(stageSpeech('ios', f.root, destination), /speech runtime/);
  Object.assign(f.manifest, { scope: 'speech-runtime', speechABIVersion: SPEECH_ABI });
  delete f.manifest.gezelABIVersion;
  await f.save();
  await stageSpeech('ios', f.root, destination);
  assert.equal(await readFile(path.join(destination, 'runtime.bin'), 'utf8'), 'verified');
  await assert.rejects(stageNative('ios', f.root, path.join(f.root, 'runtime')), /provider\/model/);
  f.manifest.speechABIVersion = SPEECH_ABI + 1;
  await f.save();
  await assert.rejects(stageSpeech('ios', f.root, destination), /speech runtime/);
});

test('rejects wrong-platform and escaping manifests', async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyRuntime(f.root, 'android'), /Expected/);
  f.manifest.files = { '../outside': sha('verified') };
  await f.save();
  await assert.rejects(verifyRuntime(f.root, 'ios'), /integrity/);
});

test('refuses to repack stale native wrapper sources', async (t) => {
  const f = await fixture(t);
  const manifest = { sources: { 'runtime.bin': sha('verified') } };
  await verifyProducerSources(manifest, f.root);
  await writeFile(path.join(f.root, 'runtime.bin'), 'edited');
  await assert.rejects(verifyProducerSources(manifest, f.root), /Restage/);
});

test('a pack outside a release warns about stale wrapper sources instead of failing', async (t) => {
  const f = await fixture(t);
  const manifest = { packageVersion: '1.2.3', sources: { 'runtime.bin': sha('verified') } };
  await writeFile(path.join(f.root, 'runtime.bin'), 'edited');
  const warnings = [];
  await verifyProducerSources(manifest, f.root, (message) => warnings.push(message), {
    allowStale: true,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /needs a new native build/);
});

test('warns instead of failing when only the license inventory changed', async (t) => {
  const f = await fixture(t);
  const licenses = path.join(f.root, 'native/licenses');
  await mkdir(licenses, { recursive: true });
  await writeFile(path.join(licenses, 'manifest.json'), 'edited');
  const manifest = {
    packageVersion: '0.1.0-local.1',
    sources: {
      'runtime.bin': sha('verified'),
      'native/licenses/manifest.json': sha('original'),
      'native/licenses/LICENSE-removed.txt': sha('removed'),
    },
  };
  const warnings = [];
  const stale = await verifyProducerSources(manifest, f.root, (message) => warnings.push(message));
  assert.deepEqual(stale, ['native/licenses/manifest.json', 'native/licenses/LICENSE-removed.txt']);
  assert.match(
    warnings.join('\n'),
    /0\.1\.0-local\.1 predates changes to native\/licenses\/manifest\.json/,
  );
  manifest.sources['../outside/native/licenses/manifest.json'] = sha('x');
  await assert.rejects(
    verifyProducerSources(manifest, f.root, () => {}),
    /Restage/,
  );
});

test('the staging ABI, both plugin bindings, and the speech header agree', async () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const read = (name) => readFile(path.join(repo, name), 'utf8');
  const header = /#define GEZEL_SPEECH_ABI (\d+)/.exec(
    await read('native/mobile/speech/gezel_speech.h'),
  );
  const java = /int ABI = (\d+);/.exec(
    await read(
      'packages/capacitor/android/src/main/java/com/bendyline/gezel/speech/SpeechRuntime.java',
    ),
  );
  const swift = /gezel_speech_abi\(\) == (\d+)/.exec(
    await read('packages/capacitor/ios/Sources/GezelCapacitor/GezelOfflineSpeechPlugin.swift'),
  );
  for (const found of [header, java, swift]) assert.equal(Number(found?.[1]), SPEECH_ABI);
});
