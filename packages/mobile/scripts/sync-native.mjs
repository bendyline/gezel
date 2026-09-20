import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after `cap sync <platform>`. Native binaries are build outputs, never
// committed assets. The iOS project links its XCFramework directly; Android
// requires all linked .so dependencies copied into its package's jniLibs.
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(mobile, '../..');
const platform = process.argv[2];
if (platform !== 'ios' && platform !== 'android') {
  throw new Error('Usage: node scripts/sync-native.mjs ios|android');
}
const build = path.join(
  repo,
  'native/mobile/.build',
  platform === 'ios' ? 'ios-bridge' : 'android',
);
const publicAssets = path.join(
  mobile,
  platform === 'ios' ? 'ios/App/App/public' : 'android/app/src/main/assets/public',
);
await access(path.join(publicAssets, 'index.html'));
if (platform === 'ios') {
  await access(path.join(build, 'GezelLlama.xcframework/Info.plist'));
  // Capacitor regenerates this declaration with `from:` during sync. Match
  // the workspace's exact npm pin so Xcode cannot resolve a newer native SDK.
  const manifest = JSON.parse(await readFile(path.join(mobile, 'package.json'), 'utf8'));
  const version = manifest.dependencies?.['@capacitor/ios'];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('@capacitor/ios must use an exact release version in package.json.');
  }
  const spmPath = path.join(mobile, 'ios/App/CapApp-SPM/Package.swift');
  const spm = await readFile(spmPath, 'utf8');
  const declaration =
    /\.package\(\s*url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git"\s*,\s*(?:from|exact):\s*"[^"\r\n]+"\s*\)/g;
  if ([...spm.matchAll(declaration)].length !== 1) {
    throw new Error(
      'Expected one Capacitor Swift package declaration after cap sync; inspect Package.swift before building.',
    );
  }
  await writeFile(
    spmPath,
    spm.replace(
      declaration,
      `.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "${version}")`,
    ),
  );
} else {
  const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
  const ndk = manifest.toolchains?.ndk;
  if (
    manifest.target !== 'android' ||
    typeof ndk !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(ndk) ||
    Number(ndk.split('.')[0]) < 28
  ) {
    throw new Error('Build the Android native libraries with a release NDK r28+ before syncing.');
  }
  const source = path.join(build, 'jniLibs');
  const libraries = await readdir(source);
  if (!libraries.includes('arm64-v8a'))
    throw new Error('Build the arm64-v8a Android native libraries first.');
  await cp(source, path.join(mobile, 'android/app/src/main/jniLibs'), { recursive: true });
  // JNI and the staged C++ runtime must come from the same NDK revision.
  await writeFile(path.join(mobile, 'android/native-toolchain.properties'), `ndkVersion=${ndk}\n`);
}
const licenses = path.join(publicAssets, 'licenses/native');
await mkdir(licenses, { recursive: true });
for (const name of ['LICENSE-llama-cpp.txt', 'LICENSE-ggml.txt']) {
  await cp(path.join(build, name), path.join(licenses, name));
}
console.log(`Prepared ${platform} native artifacts and licenses.`);
