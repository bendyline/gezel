import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  SPEECH_ABI,
  readZipTextEntries,
  stageNative,
  stageSpeech,
  verifyPluginRuntimeApi,
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
  assert.match(warnings[0], /ship when the pin moves/);
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

/** A deflated zip, the way a Maven sources jar stores its entries. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const SWIFT_SOURCE = 'native/runtime/ios/Sources/GezelRuntime/GezelNativeRuntime.swift';
const JAVA_SOURCE =
  'native/runtime/android/src/main/java/com/bendyline/gezel/runtime/GezelNativeRuntime.java';

/** A pinned release (1.2.3) and a repo whose runtime has since gained API. */
async function apiFixture(t, { swiftPlugin, javaPlugin }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gezel-capacitor-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name, text) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  const capacitor = path.join(root, 'packages/capacitor');
  await write(
    'packages/capacitor/native/ios/Sources/GezelRuntime/GezelNativeRuntime.swift',
    'public final class GezelNativeRuntime {\n  public static func shared() -> GezelNativeRuntime { .init() }\n  public func load() {}\n}\n',
  );
  await write(
    SWIFT_SOURCE,
    'public final class GezelNativeRuntime {\n  public static func shared() -> GezelNativeRuntime { .init() }\n  public func load() {}\n  public func unloadAll() {}\n  public static let willRunModelNotification = Notification.Name("GezelRuntimeWillRunModel")\n}\n',
  );
  const jar = zip({
    'com/bendyline/gezel/runtime/GezelNativeRuntime.java':
      'package com.bendyline.gezel.runtime;\npublic final class GezelNativeRuntime {\n  public boolean reserveModelMutation() { return true; }\n}\n',
  });
  await mkdir(
    path.join(capacitor, 'native/android/maven/com/bendyline/gezel/gezel-runtime/1.2.3'),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(
      capacitor,
      'native/android/maven/com/bendyline/gezel/gezel-runtime/1.2.3/gezel-runtime-1.2.3-sources.jar',
    ),
    jar,
  );
  await write(
    JAVA_SOURCE,
    'package com.bendyline.gezel.runtime;\npublic final class GezelNativeRuntime {\n  public boolean reserveModelMutation() { return true; }\n  public long physicalMemory() { return 0; }\n}\n',
  );
  await write(
    'packages/capacitor/ios/Sources/GezelCapacitor/GezelRuntimePlugin.swift',
    swiftPlugin,
  );
  await write(
    'packages/capacitor/android/src/main/java/com/bendyline/gezel/capacitor/GezelRuntimePlugin.java',
    javaPlugin,
  );
  const manifest = {
    packageVersion: '1.2.3',
    sources: { [SWIFT_SOURCE]: 'x', [JAVA_SOURCE]: 'x' },
  };
  return { root, capacitor, manifest };
}

const robustSwift = `import GezelRuntime
// GezelNativeRuntime.willRunModelNotification is observed by name, so a
// runtime older than it simply never posts it.
let willRun = Notification.Name("GezelRuntimeWillRunModel")
let runtime = GezelNativeRuntime.shared()
runtime.load()
let note = "unloadAll arrives with the next native release"
`;
const robustJava = `package com.bendyline.gezel.capacitor;
class GezelRuntimePlugin {
  // physicalMemory() is newer than the pinned runtime; read the map key instead.
  long memory(org.json.JSONObject library) { return library.optLong("physicalMemoryBytes", 0); }
  boolean busy(com.bendyline.gezel.runtime.GezelNativeRuntime runtime) { return !runtime.reserveModelMutation(); }
}
`;

test('a plugin that reaches newer runtime API by name passes against the pinned release', async (t) => {
  const f = await apiFixture(t, { swiftPlugin: robustSwift, javaPlugin: robustJava });
  const warnings = [];
  await verifyPluginRuntimeApi({
    capacitorRoot: f.capacitor,
    repoRoot: f.root,
    manifest: f.manifest,
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, []);
});

test('refuses a Swift plugin that calls runtime API the pinned release lacks', async (t) => {
  const f = await apiFixture(t, {
    swiftPlugin: `${robustSwift}runtime.unloadAll()\nNotificationCenter.default.addObserver(forName: GezelNativeRuntime.willRunModelNotification, object: nil, queue: nil) { _ in }\n`,
    javaPlugin: robustJava,
  });
  await assert.rejects(
    verifyPluginRuntimeApi({ capacitorRoot: f.capacitor, repoRoot: f.root, manifest: f.manifest }),
    /native-v1\.2\.3 does not have \(ios\/Sources\/GezelCapacitor\/GezelRuntimePlugin\.swift uses unloadAll, willRunModelNotification\)/,
  );
});

test('refuses a Java plugin that calls runtime API missing from the pinned sources jar', async (t) => {
  const f = await apiFixture(t, {
    swiftPlugin: robustSwift,
    javaPlugin: robustJava.replace(
      'return library.optLong("physicalMemoryBytes", 0);',
      'return com.bendyline.gezel.runtime.GezelNativeRuntime.class.cast(null).physicalMemory();',
    ),
  });
  await assert.rejects(
    verifyPluginRuntimeApi({ capacitorRoot: f.capacitor, repoRoot: f.root, manifest: f.manifest }),
    /GezelRuntimePlugin\.java uses physicalMemory/,
  );
});

test('a pinned runtime without sources is reported, not guessed at', async (t) => {
  const f = await apiFixture(t, { swiftPlugin: robustSwift, javaPlugin: robustJava });
  await rm(path.join(f.capacitor, 'native/android/maven'), { recursive: true });
  const warnings = [];
  await verifyPluginRuntimeApi({
    capacitorRoot: f.capacitor,
    repoRoot: f.root,
    manifest: f.manifest,
    warn: (message) => warnings.push(message),
  });
  assert.match(warnings.join('\n'), /java runtime ships no sources/);
});

test('reads the text entries of a deflated sources jar', () => {
  const entries = readZipTextEntries(zip({ 'a/A.java': 'class A {}', 'b.txt': 'skip' }), (name) =>
    name.endsWith('.java'),
  );
  assert.deepEqual([...entries], [['a/A.java', 'class A {}']]);
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
