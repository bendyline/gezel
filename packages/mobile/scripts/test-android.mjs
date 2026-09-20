import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
const adb = join(sdk, 'platform-tools/adb');
const expectedAvd = process.env.GEZEL_ANDROID_TEST_AVD || 'gezel-api36-tests';

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

accessSync(adb);
const devices = capture(adb, ['devices'])
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(([serial]) => serial);
// Gradle's connected suite can visit every device. Keep its destructive test
// installation confined to one explicitly named development emulator.
if (devices.length !== 1 || !devices[0][0].startsWith('emulator-') || devices[0][1] !== 'device') {
  throw new Error(`Connect only the ${expectedAvd} emulator before running Android tests.`);
}
const serial = devices[0][0];
const avd = capture(adb, ['-s', serial, 'emu', 'avd', 'name']).split('\n')[0].trim();
if (avd !== expectedAvd) {
  throw new Error(`Expected test emulator ${expectedAvd}, found ${avd}.`);
}
const abi = capture(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi']);
if (abi !== 'arm64-v8a')
  throw new Error(`The current Android app requires arm64-v8a, found ${abi}.`);

let javaHome = process.env.JAVA_HOME;
if (!javaHome && process.platform === 'darwin') {
  javaHome = capture('/usr/libexec/java_home', ['-v', '21']);
}
if (!javaHome)
  throw new Error('Set JAVA_HOME to an installed JDK 21 before running Android tests.');
const version = spawnSync(join(javaHome, 'bin/java'), ['-version'], { encoding: 'utf8' });
if (version.error || version.status !== 0 || !/version "21\./.test(version.stderr)) {
  throw new Error('Android tests require JAVA_HOME to point to JDK 21.');
}

console.log(`Testing the Android app on ${avd} (${serial}).`);
const result = spawnSync(
  './gradlew',
  [
    ':app:assembleDebug',
    ':app:connectedDebugAndroidTest',
    '--console=plain',
    ...process.argv.slice(2),
  ],
  {
    cwd: join(mobile, 'android'),
    stdio: 'inherit',
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      ANDROID_HOME: sdk,
      ANDROID_SERIAL: serial,
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
