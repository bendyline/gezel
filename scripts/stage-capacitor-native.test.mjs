import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import {
  SPEECH_ABI,
  verifySpeechDistribution,
} from '../packages/capacitor/scripts/stage-native.mjs';
import {
  archiveHash,
  needsPinnedPayload,
  parseNativePin,
  stagePinnedMobileSdks,
} from './stage-capacitor-native.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = 'native/runtime/stage-sdk.py';

const FRAMEWORK = 'GezelSpeech.xcframework/ios-arm64/GezelSpeech.framework';
const plist = (entries) =>
  `<plist version="1.0"><dict>${Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('')}</dict></plist>`;

/** A speech runtime as build.py --package lays it out; `as0161` is what native-v0.1.61 shipped. */
function speechFiles(target, { as0161 = false } = {}) {
  const files = { 'LICENSE-whisper.txt': 'notice' };
  if (target === 'ios') {
    files[`${FRAMEWORK}/GezelSpeech`] = 'library';
    files[`${FRAMEWORK}/Info.plist`] = as0161
      ? plist({ CFBundleShortVersionString: '', CFBundleVersion: '' })
      : plist({
          CFBundleShortVersionString: '1.2.3',
          CFBundleVersion: '1.2.3',
          MinimumOSVersion: '16.4',
        });
    if (!as0161) files[`${FRAMEWORK}/PrivacyInfo.xcprivacy`] = plist({});
  } else {
    const dependency = as0161
      ? ''
      : '<dependency><groupId>com.bendyline.gezel</groupId><artifactId>gezel-llama</artifactId><version>1.2.3</version></dependency>';
    files['maven/com/bendyline/gezel/gezel-speech/1.2.3/gezel-speech-1.2.3.pom'] =
      `<project><dependencies>${dependency}</dependencies></project>`;
  }
  return files;
}

/** A repo with a pin, and a fake release whose archives hold the given source hash. */
async function fixture(t, { sourceHash, tamper, speech = true, as0161 = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-stage-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, 'packed');
  await mkdir(join(root, 'native/runtime'), { recursive: true });
  await writeFile(join(root, SOURCE), 'wrapper');
  const assets = new Map();
  let sums = '';
  for (const target of ['ios', 'android']) {
    const payload = join(packed, target);
    await mkdir(payload, { recursive: true });
    await writeFile(join(payload, 'engine.bin'), `engine ${target}`);
    await writeFile(
      join(payload, 'sdk-manifest.json'),
      JSON.stringify({
        scope: 'provider-model-runtime',
        target,
        gezelABIVersion: 1,
        packageVersion: '1.2.3',
        files: { 'engine.bin': sha256(`engine ${target}`) },
        sources: { [SOURCE]: sourceHash ?? sha256('wrapper') },
      }),
    );
    const name = `gezel-mobile-1.2.3-${target}.tar.gz`;
    await tar.c({ gzip: true, cwd: payload, file: join(packed, name) }, [
      'sdk-manifest.json',
      'engine.bin',
    ]);
    const archive = await readFile(join(packed, name));
    assets.set(name, archive);
    sums += `${sha256(archive)}  ${name}\n`;
    if (!speech) continue;
    const runtime = join(packed, `speech-${target}`);
    const files = speechFiles(target, { as0161 });
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(runtime, name)), { recursive: true });
      await writeFile(join(runtime, name), content);
    }
    await writeFile(
      join(runtime, 'sdk-manifest.json'),
      JSON.stringify({
        scope: 'speech-runtime',
        target,
        speechABIVersion: SPEECH_ABI,
        packageVersion: '1.2.3',
        files: Object.fromEntries(Object.entries(files).map(([name, c]) => [name, sha256(c)])),
      }),
    );
    const speechName = `gezel-mobile-1.2.3-speech-${target}.tar.gz`;
    await tar.c({ gzip: true, cwd: runtime, file: join(packed, speechName) }, [
      'sdk-manifest.json',
      ...Object.keys(files),
    ]);
    const speechArchive = await readFile(join(packed, speechName));
    assets.set(speechName, speechArchive);
    sums += `${sha256(speechArchive)}  ${speechName}\n`;
  }
  if (tamper) assets.set('gezel-mobile-1.2.3-ios.tar.gz', Buffer.from('tampered'));
  assets.set('SHA256SUMS', Buffer.from(sums));
  await mkdir(join(root, 'packages/inference/src/engines'), { recursive: true });
  await writeFile(
    join(root, 'packages/inference/src/engines/native-manifest.ts'),
    `export const NATIVE_ENGINE_RELEASE = '1.2.3';\nexport const SHA256SUMS_DIGEST = '${sha256(sums)}';\n`,
  );
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const bytes = assets.get(url.split('/').pop());
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  };
  return { root, fetchImpl, requests, assets };
}

const input = (f, extra = {}) => ({
  repoRoot: f.root,
  fetchImpl: f.fetchImpl,
  log: () => {},
  ...extra,
});

test('reads the pin the way pin-native-release.mjs writes it', async () => {
  const source = await readFile(
    join(repo, 'packages/inference/src/engines/native-manifest.ts'),
    'utf8',
  );
  const { release, digest } = parseNativePin(source);
  assert.match(release, /^\d+\.\d+\.\d+$/);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.throws(() => parseNativePin('export const OTHER = 1;'), /no usable release pin/);
});

test('finds an archive hash in SHA256SUMS, and refuses an unlisted archive', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    archiveHash(`${hash}  other.tar.gz\n${hash} *wanted.tar.gz\n`, 'wanted.tar.gz'),
    hash,
  );
  assert.throws(() => archiveHash(`${hash}  other.tar.gz\n`, 'wanted.tar.gz'), /does not list/);
});

test('keeps a build staged on purpose, and replaces a stale release', () => {
  assert.equal(needsPinnedPayload(null, '1.2.3'), true);
  assert.equal(needsPinnedPayload('1.2.3', '1.2.3'), false);
  assert.equal(needsPinnedPayload('1.2.2', '1.2.3'), true);
  assert.equal(needsPinnedPayload('0.0.0-ci.9.1', '1.2.3'), false);
  assert.equal(needsPinnedPayload('0.0.0-ci.9.1', '1.2.3', true), true);
});

test('stages both platforms and their speech runtimes from the pinned release, then does nothing', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await stagePinnedMobileSdks(input(f))).staged, [
    'ios',
    'speech-ios',
    'android',
    'speech-android',
  ]);
  for (const directory of ['ios', 'speech-android']) {
    const manifest = join(f.root, `packages/capacitor/native/${directory}/sdk-manifest.json`);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).packageVersion, '1.2.3');
  }

  f.requests.length = 0;
  assert.deepEqual((await stagePinnedMobileSdks(input(f))).staged, []);
  assert.deepEqual(f.requests, [], 'a current payload costs no download');
});

test('refuses a SHA256SUMS the build did not pin', async (t) => {
  const f = await fixture(t);
  f.assets.set('SHA256SUMS', Buffer.from('substituted'));
  await assert.rejects(stagePinnedMobileSdks(input(f)), /does not match the pinned digest/);
});

test('refuses an archive that does not match SHA256SUMS', async (t) => {
  const f = await fixture(t, { tamper: true });
  await assert.rejects(stagePinnedMobileSdks(input(f)), /does not match SHA256SUMS/);
});

test('the release gate ships the pinned release and only reports later runtime changes', async (t) => {
  // native/runtime moving past the pin is normal: those changes ship when the
  // pin moves. A release must never wait for a native build because of it.
  const f = await fixture(t, { sourceHash: sha256('an older wrapper') });
  const logs = [];
  await stagePinnedMobileSdks(input(f, { releaseGate: true, log: (line) => logs.push(line) }));
  assert.match(logs.join('\n'), /1\.2\.3 predates changes to native\/runtime\/stage-sdk\.py/);
  assert.match(logs.join('\n'), /native-v1\.2\.3 verified as pinned/);
});

test('the release gate accepts a pinned payload matching its sources', async (t) => {
  const f = await fixture(t);
  await stagePinnedMobileSdks(input(f, { releaseGate: true }));
});

test('a release without speech packs without it, and can never be published', async (t) => {
  const f = await fixture(t, { speech: false });
  const logs = [];
  const { staged } = await stagePinnedMobileSdks(input(f, { log: (line) => logs.push(line) }));
  assert.deepEqual(staged, ['ios', 'android']);
  assert.match(logs.join('\n'), /has no speech-ios runtime/);
  await assert.rejects(
    stagePinnedMobileSdks(input(f, { releaseGate: true })),
    /native-v1\.2\.3 has no speech-ios runtime\. Cut a native release/,
  );
});

test('a speech runtime shaped like native-v0.1.61 stages, but can never be published', async (t) => {
  const f = await fixture(t, { as0161: true });
  const { staged } = await stagePinnedMobileSdks(input(f));
  assert.deepEqual(staged, ['ios', 'speech-ios', 'android', 'speech-android']);
  await assert.rejects(
    stagePinnedMobileSdks(input(f, { releaseGate: true })),
    /Info\.plist has no CFBundleShortVersionString.*native-v1\.2\.3's speech runtime cannot ship/,
  );
  await assert.rejects(
    verifySpeechDistribution(join(f.root, 'packages/capacitor/native/speech-android'), 'android'),
    /POM does not depend on gezel-llama 1\.2\.3/,
  );
});

test('the release gate refuses a package whose speech runtime is missing', async (t) => {
  const f = await fixture(t);
  await stagePinnedMobileSdks(input(f));
  await rm(join(f.root, 'packages/capacitor/native/speech-android'), { recursive: true });
  f.assets.delete('gezel-mobile-1.2.3-speech-android.tar.gz');
  await assert.rejects(stagePinnedMobileSdks(input(f, { releaseGate: true })), /speech/);
});

test('the release gate replaces a CI build rather than shipping it', async (t) => {
  const f = await fixture(t);
  await stagePinnedMobileSdks(input(f));
  const staged = join(f.root, 'packages/capacitor/native/ios');
  const manifest = JSON.parse(await readFile(join(staged, 'sdk-manifest.json'), 'utf8'));
  manifest.packageVersion = '0.0.0-ci.9.1';
  await cp(staged, `${staged}.ci`, { recursive: true });
  await writeFile(join(staged, 'sdk-manifest.json'), JSON.stringify(manifest));
  const { staged: replaced } = await stagePinnedMobileSdks(input(f, { releaseGate: true }));
  assert.deepEqual(replaced, ['ios']);
});

test('packing offline still works when only a speech runtime is missing', async (t) => {
  const f = await fixture(t, { speech: false });
  await stagePinnedMobileSdks(input(f));
  const logs = [];
  const offline = input(f, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual((await stagePinnedMobileSdks(offline)).staged, []);
  assert.match(logs.join('\n'), /could not check native-v1\.2\.3 for a speech runtime/);
  await assert.rejects(stagePinnedMobileSdks({ ...offline, releaseGate: true }), /offline/);
});
