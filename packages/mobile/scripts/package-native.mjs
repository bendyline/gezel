import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDependencyReadLease } from '../../../scripts/dependency-lease.mjs';
import { withReleaseCandidate } from './release-candidate.mjs';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(mobile, '../..');
const platform = process.argv[2];
if (!['android', 'ios'].includes(platform))
  throw new Error(
    'Usage: pnpm mobile:package android|ios [build-number]. Produces unsigned release artifacts.',
  );
const buildNumber = process.argv[3] ?? process.env.GEZEL_MOBILE_BUILD_NUMBER ?? '1';
if (!/^[1-9]\d{0,8}$/.test(buildNumber))
  throw new Error('Build number must be a positive integer of at most nine digits.');
const version = JSON.parse(
  await readFile(path.join(repo, 'packages/core/package.json'), 'utf8'),
).version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Native release version must have three numeric components.');
const out = path.resolve(
  process.env.GEZEL_MOBILE_RELEASE_DIR ?? path.join(mobile, '.build/release', platform),
);
await withReleaseCandidate(out, async (stage) => {
  const manifest = {
    platform,
    version,
    buildNumber: Number(buildNumber),
    unsigned: true,
    createdAt: new Date().toISOString(),
    artifacts: [],
  };
  await withDependencyReadLease(repo, async ({ leaseEnv }) => {
    const env = { ...process.env, ...leaseEnv };
    const run = (command, args, cwd = repo, extraEnv = {}, captureJson = false) => {
      const result = spawnSync(command, args, {
        cwd,
        env: { ...env, ...extraEnv },
        stdio: captureJson ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`${path.basename(command)} exited with ${result.status}`);
      if (captureJson) {
        process.stdout.write(result.stdout);
        return JSON.parse(result.stdout);
      }
    };
    run('pnpm', ['mobile:build']);
    run('pnpm', ['--filter', '@bendyline/gezel-mobile', 'run', `sync:${platform}`]);
    if (platform === 'android') {
      const sdk =
        env.ANDROID_HOME ||
        env.ANDROID_SDK_ROOT ||
        path.join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
      let javaHome = env.JAVA_HOME;
      if (!javaHome && process.platform === 'darwin') {
        const resolved = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
        if (resolved.status === 0) javaHome = resolved.stdout.trim();
      }
      if (!javaHome) throw new Error('Set JAVA_HOME to the installed JDK 21.');
      run(
        './gradlew',
        [
          ':app:assembleRelease',
          ':app:bundleRelease',
          '--offline',
          '--console=plain',
          `-PgezelVersionName=${version}`,
          `-PgezelVersionCode=${buildNumber}`,
        ],
        path.join(mobile, 'android'),
        { JAVA_HOME: javaHome, ANDROID_HOME: sdk },
      );
      const nativeManifest = JSON.parse(
        await readFile(path.join(repo, 'native/mobile/.build/android/manifest.json'), 'utf8'),
      );
      const prebuilts = path.join(
        sdk,
        'ndk',
        nativeManifest.toolchains.ndk,
        'toolchains/llvm/prebuilt',
      );
      const host = (await readdir(prebuilts)).find((name) =>
        name.startsWith(
          process.platform === 'darwin'
            ? 'darwin-'
            : process.platform === 'win32'
              ? 'windows-'
              : 'linux-',
        ),
      );
      if (!host) throw new Error('The pinned Android NDK host tools are unavailable.');
      const readelf = path.join(
        prebuilts,
        host,
        'bin',
        process.platform === 'win32' ? 'llvm-readelf.exe' : 'llvm-readelf',
      );
      for (const [relative, name] of [
        ['apk/release/app-release-unsigned.apk', 'gezel-unsigned.apk'],
        ['bundle/release/app-release.aab', 'gezel-unsigned.aab'],
      ]) {
        const target = path.join(stage, name);
        await copyFile(path.join(mobile, 'android/app/build/outputs', relative), target);
        const verification = run(
          process.env.PYTHON ?? 'python3',
          [
            path.join(mobile, 'scripts/verify-android-package.py'),
            target,
            '--readelf',
            readelf,
            '--web-dir',
            path.join(mobile, 'dist'),
          ],
          repo,
          {},
          true,
        );
        const data = await readFile(target);
        manifest.artifacts.push({
          path: target,
          bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          verification,
        });
      }
      const toolsVersion = env.GEZEL_ANDROID_BUILD_TOOLS ?? '36.0.0';
      run(path.join(sdk, 'build-tools', toolsVersion, 'zipalign'), [
        '-c',
        '-P',
        '16',
        '4',
        path.join(stage, 'gezel-unsigned.apk'),
      ]);
    } else {
      if (process.platform !== 'darwin') throw new Error('iOS packaging requires macOS and Xcode.');
      const archive = path.join(stage, 'Gezel.xcarchive');
      const args = [
        '-project',
        path.join(mobile, 'ios/App/App.xcodeproj'),
        '-scheme',
        'App',
        '-configuration',
        'Release',
        '-destination',
        'generic/platform=iOS',
        '-archivePath',
        archive,
        '-derivedDataPath',
        env.GEZEL_MOBILE_IOS_BUILD_DIR ?? path.join(mobile, '.build/ios-release'),
        '-disableAutomaticPackageResolution',
        '-onlyUsePackageVersionsFromResolvedFile',
        '-skipPackageUpdates',
        'CODE_SIGNING_ALLOWED=NO',
        `MARKETING_VERSION=${version}`,
        `CURRENT_PROJECT_VERSION=${buildNumber}`,
        'archive',
      ];
      if (env.GEZEL_MOBILE_SPM_DIR)
        args.splice(-1, 0, '-clonedSourcePackagesDirPath', env.GEZEL_MOBILE_SPM_DIR);
      run('xcodebuild', args);
      const verification = run(
        process.env.PYTHON ?? 'python3',
        [
          path.join(mobile, 'scripts/verify-ios-archive.py'),
          archive,
          '--version',
          version,
          '--build-number',
          buildNumber,
          '--web-dir',
          path.join(mobile, 'dist'),
        ],
        repo,
        {},
        true,
      );
      manifest.artifacts.push({ path: archive, kind: 'xcarchive', verification });
    }
  });
  return manifest;
});
console.log(`Unsigned ${platform} release artifacts: ${out}`);
