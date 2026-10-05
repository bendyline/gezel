import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  configureCapacitorProject,
  verifyCapacitorPackage,
  writeEmbeddingManifest,
} from './embedding-package.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
test('installed package doctor checks both compatibility and complete native inventories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gezel-plugin-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@bendyline/gezel-capacitor',
      version: '0.1.0',
      peerDependencies: { '@capacitor/core': '^8.5.2' },
    }),
  );
  for (const dir of ['dist', 'ios/Sources', 'android/src', 'scripts'])
    await mkdir(path.join(root, dir), { recursive: true });
  for (const file of [
    'android/build.gradle',
    'scripts/embedding-package.mjs',
    'scripts/embedding-package.d.mts',
    'scripts/stage-native.mjs',
  ])
    await writeFile(path.join(root, file), 'fixture');
  await writeFile(path.join(root, 'dist/index.js'), 'export const fixture = true;');
  await writeFile(path.join(root, 'Package.swift'), '// fixture');
  for (const target of ['ios', 'android']) {
    const directory = path.join(root, 'native', target);
    await mkdir(directory, { recursive: true });
    const files = {
      'engine-manifest.json': JSON.stringify({
        target,
        gezelABIVersion: 1,
        settings: target === 'ios' ? { minimumOS: '16.4' } : { minimumAPI: 28 },
        toolchains: {},
      }),
      LICENSE: 'fixture license',
      'runtime.bin': 'fixture bytes',
    };
    for (const [name, data] of Object.entries(files))
      await writeFile(path.join(directory, name), data);
    await writeFile(
      path.join(directory, 'sdk-manifest.json'),
      JSON.stringify({
        scope: 'provider-model-runtime',
        target,
        packageVersion: '0.1.0',
        gezelABIVersion: 1,
        deviceInference: 'not-run',
        files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, hash(data)])),
      }),
    );
  }
  const manifest = await writeEmbeddingManifest(root);
  assert.equal(manifest.native.ios.abi, 1);
  await verifyCapacitorPackage(root);
  const app = path.join(root, 'consumer');
  for (const dir of ['ios/App/App.xcodeproj', 'ios/App/CapApp-SPM', 'android'])
    await mkdir(path.join(app, dir), { recursive: true });
  await writeFile(
    path.join(app, 'ios/App/App.xcodeproj/project.pbxproj'),
    'IPHONEOS_DEPLOYMENT_TARGET = 15.0;\nIPHONEOS_DEPLOYMENT_TARGET = 17.0;',
  );
  await writeFile(path.join(app, 'ios/App/CapApp-SPM/Package.swift'), 'platforms: [.iOS(.v15)]');
  await writeFile(path.join(app, 'android/variables.gradle'), 'ext { minSdkVersion = 24 }');
  assert.equal(
    (await configureCapacitorProject({ projectRoot: app, platform: 'ios', sdkRoot: root })).changed
      .length,
    2,
  );
  assert.match(await readFile(path.join(app, 'ios/App/CapApp-SPM/Package.swift'), 'utf8'), /16.4/);
  assert.match(
    await readFile(path.join(app, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8'),
    /17.0/,
  );
  await configureCapacitorProject({ projectRoot: app, platform: 'android', sdkRoot: root });
  assert.match(await readFile(path.join(app, 'android/variables.gradle'), 'utf8'), /28/);

  await writeFile(path.join(root, 'native/android/injected.so'), 'unlisted');
  await assert.rejects(verifyCapacitorPackage(root), /inventory/);
  await rm(path.join(root, 'native/android/injected.so'));
  await writeFile(path.join(root, 'dist/index.js'), 'altered');
  await assert.rejects(verifyCapacitorPackage(root), /integrity/);
  const saved = JSON.parse(await readFile(path.join(root, 'embedding-manifest.json'), 'utf8'));
  saved.files = { '../outside': 'a'.repeat(64) };
  await writeFile(path.join(root, 'embedding-manifest.json'), JSON.stringify(saved));
  await assert.rejects(verifyCapacitorPackage(root));
});
