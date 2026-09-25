import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceNativeAssets } from './stage-native-assets.mjs';
import { stageSpeech } from './stage-speech.mjs';
import { normalizeSwiftPackage } from './swift-package.mjs';
import { verifyNativeBuild } from './verify-native-build.mjs';

// Run after `cap sync <platform>`. Native binaries are build outputs, never
// committed assets. Inference comes from the reusable Capacitor package;
// speech remains app-owned and is staged here.
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(mobile, '../..');
const platform = process.argv[2];
if (platform !== 'ios' && platform !== 'android') {
  throw new Error('Usage: node scripts/sync-native.mjs ios|android');
}
const build =
  process.env.GEZEL_MOBILE_NATIVE_BUILD ||
  path.join(repo, 'native/mobile/.build', platform === 'ios' ? 'ios-bridge' : 'android');
const publicAssets = path.join(
  mobile,
  platform === 'ios' ? 'ios/App/App/public' : 'android/app/src/main/assets/public',
);
await access(path.join(publicAssets, 'index.html'));
const native = await verifyNativeBuild(repo, build, platform);
const speech = await stageSpeech(repo, mobile, platform);
const replacements = [];
if (platform === 'ios') {
  await access(path.join(build, 'GezelLlama.xcframework/Info.plist'));
  // Capacitor regenerates this declaration with `from:` during sync. Match
  // the workspace's exact npm pin so Xcode cannot resolve a newer native SDK.
  const manifest = JSON.parse(await readFile(path.join(mobile, 'package.json'), 'utf8'));
  const version = manifest.dependencies?.['@capacitor/ios'];
  const spmPath = path.join(mobile, 'ios/App/CapApp-SPM/Package.swift');
  const spm = await readFile(spmPath, 'utf8');
  replacements.push({
    target: spmPath,
    content: normalizeSwiftPackage(spm, version, native.settings?.minimumOS),
  });
} else {
  const ndk = native.toolchains?.ndk;
  if (typeof ndk !== 'string' || !/^\d+\.\d+\.\d+$/.test(ndk) || Number(ndk.split('.')[0]) < 28) {
    throw new Error('Build the Android native libraries with a release NDK r28+ before syncing.');
  }
  const source = path.join(build, 'jniLibs');
  const libraries = await readdir(source);
  if (!libraries.includes('arm64-v8a'))
    throw new Error('Build the arm64-v8a Android native libraries first.');
  replacements.push({
    target: path.join(mobile, 'android/app/src/main/jniLibs'),
    files: [
      ...Object.entries(speech.manifest.files)
        .filter(([name]) => name.endsWith('.so'))
        .map(([name, sha256]) => ({
          relative: `arm64-v8a/${name}`,
          source: path.join(speech.root, name),
          sha256,
        })),
    ],
  });
  // JNI and the staged C++ runtime must come from the same NDK revision.
  replacements.push({
    target: path.join(mobile, 'android/native-toolchain.properties'),
    content: `ndkVersion=${ndk}\n`,
  });
}
const licenses = path.join(publicAssets, 'licenses/native');
replacements.push({
  target: licenses,
  files: [
    ...['LICENSE-llama-cpp.txt', 'LICENSE-ggml.txt'].map((name) => ({
      relative: name,
      source: path.join(build, name),
      sha256: native.files[name],
    })),
    ...Object.entries(speech.manifest.files)
      .filter(([name]) => /^(LICENSE|NOTICE)-/.test(name))
      .map(([name, sha256]) => ({
        relative: name,
        source: path.join(speech.root, name),
        sha256,
      })),
    {
      relative: 'LICENSE-kokoro.txt',
      source: path.join(speech.root, 'models/kokoro/LICENSE'),
      sha256: speech.manifest.files['models/kokoro/LICENSE'],
    },
  ],
});
await replaceNativeAssets(replacements);
console.log(`Prepared ${platform} native artifacts and licenses.`);
