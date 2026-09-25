import { spawnSync } from 'node:child_process';
import { accessSync, mkdirSync, writeFileSync } from 'node:fs';
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
function remoteCommand(argv) {
  return argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

accessSync(adb);
const devices = capture(adb, ['devices'])
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(
    ([serial]) => serial && (!process.env.ANDROID_SERIAL || serial === process.env.ANDROID_SERIAL),
  );
// Test APKs are installed in place on the explicitly named development emulator.
if (devices.length !== 1 || !devices[0][0].startsWith('emulator-') || devices[0][1] !== 'device') {
  throw new Error(
    `Connect only the ${expectedAvd} emulator, or select it with ANDROID_SERIAL, before running Android tests.`,
  );
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
const gradleArgs = [];
const runnerArgs = [];
let requestedNativeOutput;
const prefix = '-Pandroid.testInstrumentationRunnerArguments.';
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith(prefix)) {
    const separator = argument.indexOf('=', prefix.length);
    if (separator < 0) throw new Error(`Expected an instrumentation name=value: ${argument}`);
    const name = argument.slice(prefix.length, separator);
    if (name === 'gezelEval')
      throw new Error('Use mobile:eval for quality evaluation and its exclusive model lock.');
    if (name === 'additionalTestOutputDir') requestedNativeOutput = argument.slice(separator + 1);
    runnerArgs.push('-e', name, argument.slice(separator + 1));
  } else {
    if (!argument.startsWith('-'))
      throw new Error('Additional Gradle tasks are not accepted by the preserving test runner.');
    gradleArgs.push(argument);
  }
}
const result = spawnSync(
  './gradlew',
  [
    ':app:assembleDebug',
    ':app:assembleDebugAndroidTest',
    '--offline',
    '--console=plain',
    ...gradleArgs,
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
if (result.status !== 0) process.exit(result.status ?? 1);
for (const apk of ['apk/debug/app-debug.apk', 'apk/androidTest/debug/app-debug-androidTest.apk'])
  capture(adb, ['-s', serial, 'install', '-r', join(mobile, 'android/app/build/outputs', apk)]);
const runId = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, '');
const output = resolve(
  process.env.GEZEL_ANDROID_TEST_OUTPUT_DIR ||
    join(mobile, 'android/app/build/outputs/native-tests', runId),
);
mkdirSync(output, { recursive: true });
const nativeOutput =
  requestedNativeOutput ||
  `/data/user/0/com.bendyline.gezel.mobile/cache/mobile-test-output-${runId}`;
if (!requestedNativeOutput) runnerArgs.push('-e', 'additionalTestOutputDir', nativeOutput);
const argv = [
  'am',
  'instrument',
  '-w',
  '-r',
  ...runnerArgs,
  'com.bendyline.gezel.mobile.test/androidx.test.runner.AndroidJUnitRunner',
];
const shell = remoteCommand(argv);
const tests = spawnSync(adb, ['-s', serial, 'shell', shell], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (tests.error) throw tests.error;
writeFileSync(join(output, 'instrumentation.log'), tests.stdout + tests.stderr);
const outcomes = [...tests.stdout.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/gm)].map(
  (match) => Number(match[1]),
);
const summary = {
  passed: outcomes.filter((code) => code === 0).length,
  skipped: outcomes.filter((code) => code === -3 || code === -4).length,
  failed: outcomes.filter((code) => code < 0 && code !== -3 && code !== -4).length,
  qualityInference: false,
};
writeFileSync(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
const screenshots = spawnSync(
  adb,
  [
    '-s',
    serial,
    'shell',
    remoteCommand([
      'run-as',
      'com.bendyline.gezel.mobile',
      'ls',
      `${nativeOutput}/ui-smoke-screenshots`,
    ]),
  ],
  { encoding: 'utf8' },
);
if (screenshots.status === 0) {
  for (const name of screenshots.stdout
    .trim()
    .split(/\s+/)
    .filter((name) => /^[a-zA-Z0-9_-]+\.png$/.test(name))) {
    const png = spawnSync(
      adb,
      [
        '-s',
        serial,
        'exec-out',
        remoteCommand([
          'run-as',
          'com.bendyline.gezel.mobile',
          'cat',
          `${nativeOutput}/ui-smoke-screenshots/${name}`,
        ]),
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    if (png.status === 0) writeFileSync(join(output, name), png.stdout);
  }
}
// Fetching from run-as also proves Gradle did not uninstall the restored app.
capture(adb, ['-s', serial, 'shell', 'run-as', 'com.bendyline.gezel.mobile', 'pwd']);
console.log(`Android test output: ${output}`);
console.log(
  `Native tests: ${summary.passed} passed, ${summary.skipped} skipped, ${summary.failed} failed. Trained-model quality requires mobile:eval.`,
);
process.exitCode =
  tests.status === 0 &&
  /OK \([1-9][0-9]* tests?\)/.test(tests.stdout) &&
  /INSTRUMENTATION_CODE: -1/.test(tests.stdout) &&
  !/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|shortMsg=/.test(tests.stdout)
    ? 0
    : 1;
