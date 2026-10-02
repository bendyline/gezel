import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableCatalogModels } from '@bendyline/gezel/runtime';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import {
  androidInstrumentationCommand,
  androidShellCommand,
  instrumentationSucceeded,
  requireAndroidStagingSpace,
} from '../mobile/android-runner.ts';
import { requireMobileBuildIdentity } from '../mobile/build-identity.ts';
import { writeMobileEvalClock, writeMobileTestResource } from '../mobile/clock.ts';
import { canonicalMobileFixtures } from '../mobile/fixtures.ts';
import { iosDeviceCopyFrom, iosDeviceCopyTo, requireReadyIosDevice } from '../mobile/ios-device.ts';
import { withNativeFeedback } from '../mobile/native-feedback.ts';
import { type MobileReport, writeMobileEvaluationReport } from '../mobile/report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (!name?.startsWith('--')) throw new Error(`Expected --flag: ${name}`);
  const value = args[index + 1];
  if (value?.startsWith('--') || !value) flags.set(name, 'true');
  else {
    flags.set(name, value);
    index++;
  }
}
const allowed = new Set([
  '--platform',
  '--device',
  '--provider',
  '--out',
  '--run-id',
  '--scenarios',
  '--context',
  '--max-tokens',
  '--trial-timeout-ms',
  '--trained-model',
  '--model-id',
  '--build-only',
  '--report-only',
  '--native-build-dir',
  '--contracts-only',
  '--physical-device',
  '--cooldown-ms',
  '--discard-backup',
  '--recover-backup',
]);
for (const key of flags.keys()) if (!allowed.has(key)) throw new Error(`Unknown flag: ${key}`);
const platform = flags.get('--platform');
if (!['ios', 'android'].includes(platform ?? ''))
  throw new Error('--platform must be ios or android');
if (platform === 'ios' && flags.has('--model-id'))
  throw new Error(
    '--model-id selects an installed Android model; iOS stages one with --trained-model.',
  );
if (platform === 'ios' && flags.has('--trained-model') && !flags.has('--physical-device'))
  throw new Error('iOS model staging goes through devicectl, so it needs --physical-device.');
if (
  flags.has('--discard-backup') &&
  (platform !== 'ios' ||
    !/^product-eval-backup-[0-9A-F-]{36}$/.test(flags.get('--discard-backup')!))
)
  throw new Error('--discard-backup names one iOS eval backup folder, as the refusal printed it');
if (
  flags.has('--recover-backup') &&
  (platform !== 'ios' ||
    flags.has('--discard-backup') ||
    !/^product-eval-backup-[0-9A-F-]{36}$/.test(flags.get('--recover-backup')!))
)
  throw new Error(
    '--recover-backup names one iOS eval backup folder to restore, and cannot be combined with --discard-backup',
  );
if (flags.has('--cooldown-ms') && !/^\d+$/.test(flags.get('--cooldown-ms')!))
  throw new Error('--cooldown-ms must be a whole number of milliseconds');
if (flags.has('--build-only') && flags.has('--contracts-only'))
  throw new Error('Choose either --build-only or --contracts-only.');
const runId =
  flags.get('--run-id') ??
  `${platform}-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, '')}`;
if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid --run-id');
const output = resolve(flags.get('--out') ?? join(root, 'evals/runs/mobile', runId));
await mkdir(output, { recursive: true });
if (flags.has('--report-only')) {
  const report = JSON.parse(
    await readFile(resolve(flags.get('--report-only')!), 'utf8'),
  ) as MobileReport;
  const result = await writeMobileEvaluationReport(report, output);
  console.log(result.summary);
  process.exitCode = result.success ? 0 : 1;
} else {
  await writeMobileEvalClock();
  await writeMobileTestResource(
    join(root, 'packages/mobile/evals/canonical-fixtures.json'),
    `${JSON.stringify(await canonicalMobileFixtures(), null, 2)}\n`,
  );
  const harnessSourceHash = createHash('sha256')
    .update(
      `${await readFile(join(root, 'packages/mobile/evals/mobile-eval-clock.js'), 'utf8')}\n${await readFile(join(root, 'packages/mobile/evals/mobile-product-eval.js'), 'utf8')}`,
    )
    .digest('hex');
  const productIndexHash = createHash('sha256')
    .update(await readFile(join(root, 'packages/mobile/dist/index.html')))
    .digest('hex');
  const provider =
    flags.get('--provider') ?? (platform === 'ios' ? 'apple-foundation-models' : 'llama-cpp');
  const device = flags.get('--device');
  if (!device)
    throw new Error('--device must explicitly identify the dedicated test simulator/emulator');
  const log = createWriteStream(join(output, 'native.log'));
  let current: ReturnType<typeof spawn> | undefined;
  const interrupt = () => current?.kill('SIGINT');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  async function command(
    executable: string,
    argv: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      inputFile?: string;
      stdoutFile?: string;
    } = {},
  ) {
    return new Promise<{ code: number; stdout: string }>((resolveCommand, reject) => {
      const child = spawn(executable, argv, {
        cwd: options.cwd ?? root,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      current = child;
      const sink = options.stdoutFile ? createWriteStream(options.stdoutFile) : undefined;
      sink?.once('error', reject);
      let stdout = '';
      child.stdout.on('data', (bytes: Buffer) => {
        if (sink) sink.write(bytes);
        else {
          stdout = (stdout + bytes.toString()).slice(-1024 * 1024);
          log.write(bytes);
        }
      });
      child.stderr.on('data', (bytes: Buffer) => log.write(bytes));
      const input = options.inputFile ? createReadStream(options.inputFile) : undefined;
      input?.once('error', reject);
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      if (input) input.pipe(child.stdin);
      else child.stdin.end();
      child.once('error', reject);
      child.once('close', (code) => {
        current = undefined;
        input?.destroy();
        const finish = () => resolveCommand({ code: code ?? 1, stdout });
        if (sink) sink.end(finish);
        else finish();
      });
    });
  }
  async function required(
    executable: string,
    argv: string[],
    options?: Parameters<typeof command>[2],
  ) {
    const result = await command(executable, argv, options);
    if (result.code !== 0)
      throw new Error(`${executable} exited ${result.code}; see ${join(output, 'native.log')}`);
    return result.stdout.trim();
  }
  let lease: ReturnType<typeof acquireEvalDeviceLock> | undefined;
  let cleanupStaged: (() => Promise<void>) | undefined;
  try {
    if (flags.has('--build-only') || flags.has('--contracts-only')) {
      console.log(
        `${flags.has('--contracts-only') ? 'Running packaged contracts on' : 'Building eval tests for'} ${platform}; no inference or device lock.`,
      );
    } else {
      lease = acquireEvalDeviceLock({ command: `mobile ${platform} ${provider} ${runId}` });
      if (!lease.acquired)
        throw new Error('Concurrent model evaluation is not allowed by this launcher');
    }
    let reportPath: string | undefined;
    let nativeCode = 0;
    if (platform === 'ios') {
      const buildDir = resolve(flags.get('--native-build-dir') ?? '/tmp/gezel-mobile-ios-build');
      const physical = flags.has('--physical-device');
      // A physical device runs only development-signed code, and its team is
      // the operator's; nothing in the repository can choose it.
      const team = process.env.GEZEL_IOS_DEVELOPMENT_TEAM;
      if (physical && !team)
        throw new Error('A physical iPhone/iPad needs GEZEL_IOS_DEVELOPMENT_TEAM for signing.');
      if (physical && !flags.has('--build-only')) await requireReadyIosDevice(device);
      const common = [
        '-project',
        'packages/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'AppSmoke',
        '-configuration',
        'Debug',
        '-destination',
        physical ? `id=${device}` : `platform=iOS Simulator,id=${device}`,
        '-derivedDataPath',
        buildDir,
        '-clonedSourcePackagesDirPath',
        process.env.GEZEL_MOBILE_SPM_DIR ?? '/tmp/gezel-mobile-spm',
        '-disableAutomaticPackageResolution',
        '-onlyUsePackageVersionsFromResolvedFile',
        '-skipPackageUpdates',
        '-collect-test-diagnostics',
        'never',
        '-test-timeouts-enabled',
        flags.has('--contracts-only') ? 'YES' : 'NO',
        '-default-test-execution-time-allowance',
        flags.has('--contracts-only') ? '300' : String(8 * 3600 + 120),
        '-only-testing:AppTests/MobileProductEvalTests',
        ...(physical
          ? [
              '-allowProvisioningUpdates',
              `DEVELOPMENT_TEAM=${team}`,
              'CODE_SIGN_STYLE=Automatic',
              // No iCloud entitlement, so an eval cannot reach the person's
              // iCloud Gezel folder, whatever the trials do.
              'CODE_SIGN_ENTITLEMENTS=',
            ]
          : ['CODE_SIGNING_ALLOWED=NO']),
      ];
      const modelEnv: Record<string, string> = {};
      const modelPath = flags.get('--trained-model');
      let built = false;
      if (modelPath && !flags.has('--build-only') && !flags.has('--contracts-only')) {
        const absolute = resolve(modelPath);
        const file = await stat(absolute);
        if (file.size <= 1024 * 1024 || file.size > 4 * 1024 ** 3)
          throw new Error('Expected a trained GGUF within the mobile 4 GiB model cap');
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(absolute)) hash.update(bytes);
        const sha = hash.digest('hex');
        // iOS publishes only as a catalog download, so the phone runs the
        // model with the catalog tuning a person who downloaded it gets.
        const download = await catalogDownloadFor(sha, file.size);
        if (!download)
          throw new Error(
            'iOS stages catalog GGUFs only; this file matches no catalog chat model.',
          );
        // Build and install first: the data container must exist, and the
        // test's own install then keeps the staged file in place.
        if ((await command('xcodebuild', [...common, 'build-for-testing'])).code !== 0)
          throw new Error('iOS eval compilation failed; see native.log');
        built = true;
        await required('xcrun', [
          'devicectl',
          'device',
          'install',
          'app',
          '--device',
          device,
          join(buildDir, 'Build/Products/Debug-iphoneos/App.app'),
        ]);
        const staged = `mobile-eval-${runId}.gguf`;
        await iosDeviceCopyTo(device, absolute, `Library/Caches/${staged}`);
        Object.assign(modelEnv, {
          TEST_RUNNER_GEZEL_EVAL_MODEL_FILE: staged,
          TEST_RUNNER_GEZEL_EVAL_MODEL_SHA256: sha,
          TEST_RUNNER_GEZEL_EVAL_MODEL_NAME: Buffer.from(download.name).toString('base64'),
          TEST_RUNNER_GEZEL_EVAL_MODEL_SOURCE: Buffer.from(
            JSON.stringify(download.source),
          ).toString('base64'),
        });
        await writeFile(
          join(output, 'model-source.json'),
          `${JSON.stringify({ path: absolute, bytes: file.size, sha256: sha, catalogId: download.source.catalogId }, null, 2)}\n`,
        );
      }
      const result = await withNativeFeedback(
        { platform: 'ios', device, runId, output, physical, log: (line) => log.write(`${line}\n`) },
        () =>
          command(
            'xcodebuild',
            [
              ...common,
              flags.has('--build-only')
                ? 'build-for-testing'
                : built
                  ? 'test-without-building'
                  : 'test',
              '-resultBundlePath',
              join(output, 'native.xcresult'),
            ],
            {
              env: {
                TEST_RUNNER_GEZEL_MOBILE_EVAL: '1',
                TEST_RUNNER_GEZEL_EVAL_RUN_ID: runId,
                TEST_RUNNER_GEZEL_EVAL_PROVIDER: provider,
                ...modelEnv,
                ...(flags.has('--cooldown-ms')
                  ? { TEST_RUNNER_GEZEL_EVAL_COOLDOWN_MS: flags.get('--cooldown-ms')! }
                  : {}),
                ...(flags.has('--discard-backup')
                  ? { TEST_RUNNER_GEZEL_EVAL_DISCARD_BACKUP: flags.get('--discard-backup')! }
                  : {}),
                ...(flags.has('--recover-backup')
                  ? { TEST_RUNNER_GEZEL_EVAL_RECOVER_BACKUP: flags.get('--recover-backup')! }
                  : {}),
                ...(flags.has('--contracts-only')
                  ? { TEST_RUNNER_GEZEL_EVAL_CONTRACTS_ONLY: '1' }
                  : {}),
                ...(flags.has('--scenarios')
                  ? { TEST_RUNNER_GEZEL_EVAL_SCENARIOS: flags.get('--scenarios')! }
                  : {}),
                ...(flags.has('--context')
                  ? { TEST_RUNNER_GEZEL_EVAL_CONTEXT: flags.get('--context')! }
                  : {}),
                ...(flags.has('--max-tokens')
                  ? { TEST_RUNNER_GEZEL_EVAL_MAX_TOKENS: flags.get('--max-tokens')! }
                  : {}),
                ...(flags.has('--trial-timeout-ms')
                  ? { TEST_RUNNER_GEZEL_EVAL_TRIAL_TIMEOUT_MS: flags.get('--trial-timeout-ms')! }
                  : {}),
              },
            },
          ),
      );
      nativeCode = result.code;
      if (physical && !flags.has('--build-only')) {
        reportPath = join(output, 'device-report.json');
        await iosDeviceCopyFrom(device, `Documents/mobile-evals/${runId}.json`, reportPath);
      } else if (!flags.has('--build-only')) {
        // XCTest may shut its dedicated simulator down after a failure. Preserve
        // the completed report without depending on another successful simctl call.
        const emitted = result.stdout
          .split('\n')
          .find((line) => line.startsWith('MOBILE_EVAL_REPORT '))
          ?.slice('MOBILE_EVAL_REPORT '.length)
          .trim();
        const containers = join(
          homedir(),
          'Library/Developer/CoreSimulator/Devices',
          device,
          'data/Containers/Data/Application',
        );
        if (
          emitted &&
          resolve(emitted).startsWith(`${containers}/`) &&
          emitted.endsWith(`/Documents/mobile-evals/${runId}.json`)
        ) {
          reportPath = emitted;
        } else {
          const container = await required('xcrun', [
            'simctl',
            'get_app_container',
            device,
            'com.bendyline.gezel.mobile',
            'data',
          ]);
          reportPath = join(container, 'Documents/mobile-evals', `${runId}.json`);
        }
      }
    } else {
      const sdk =
        process.env.ANDROID_HOME ??
        process.env.ANDROID_SDK_ROOT ??
        join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
      const adb = join(sdk, 'platform-tools/adb');
      if (!flags.has('--build-only')) {
        const devices = (await required(adb, ['devices']))
          .split('\n')
          .slice(1)
          .map((line) => line.trim().split(/\s+/))
          .filter(([serial]) => serial);
        const expectedAvd = process.env.GEZEL_ANDROID_TEST_AVD ?? 'gezel-api36-tests';
        // A phone is opted into explicitly and must be the only device
        // attached, so the installs below cannot land on anything else.
        const physical = flags.has('--physical-device');
        if (
          devices.length !== 1 ||
          devices[0]?.[0] !== device ||
          device.startsWith('emulator-') === physical ||
          devices[0]?.[1] !== 'device'
        )
          throw new Error(
            physical
              ? `Connect only the phone ${device}, with USB debugging authorized.`
              : `Connect only the dedicated ${expectedAvd} emulator (${device}).`,
          );
        if (!physical) {
          const avd = (await required(adb, ['-s', device, 'emu', 'avd', 'name']))
            .split('\n')[0]
            ?.trim();
          if (avd !== expectedAvd)
            throw new Error(`Expected test emulator ${expectedAvd}, found ${avd}.`);
        }
        const abi = await required(adb, ['-s', device, 'shell', 'getprop', 'ro.product.cpu.abi']);
        if (abi !== 'arm64-v8a')
          throw new Error(`The current Android app requires arm64-v8a, found ${abi}.`);
      }
      const env = {
        JAVA_HOME:
          process.env.JAVA_HOME ?? '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
        ANDROID_HOME: sdk,
        ANDROID_SERIAL: device,
      };
      const build = await command(
        './gradlew',
        ['--offline', '--no-daemon', ':app:assembleDebug', ':app:assembleDebugAndroidTest'],
        {
          cwd: join(root, 'packages/mobile/android'),
          env,
        },
      );
      nativeCode = build.code;
      if (build.code !== 0) throw new Error('Android eval APK compilation failed; see native.log');
      if (!flags.has('--build-only')) {
        // Gradle's connected test lifecycle may uninstall the target after @After
        // restores it. Install in place and own only the instrumentation process.
        for (const apk of [
          'apk/debug/app-debug.apk',
          'apk/androidTest/debug/app-debug-androidTest.apk',
        ])
          await required(adb, [
            '-s',
            device,
            'install',
            '-r',
            join(root, 'packages/mobile/android/app/build/outputs', apk),
          ]);
      }
      const runner: Record<string, string> = {
        class: 'com.bendyline.gezel.mobile.MobileProductEvalTest',
        gezelEval: '1',
        evalRunId: runId,
        evalProvider: provider,
      };
      if (flags.has('--contracts-only')) runner.evalContractsOnly = '1';
      for (const [flag, argument] of [
        ['--scenarios', 'evalScenarios'],
        ['--context', 'evalContext'],
        ['--max-tokens', 'evalMaxTokens'],
        ['--trial-timeout-ms', 'evalTrialTimeoutMs'],
        ['--cooldown-ms', 'evalCooldownMs'],
        ['--model-id', 'evalModelId'],
      ]) {
        const value = flags.get(flag!);
        if (value) runner[argument!] = value;
      }
      const modelPath = flags.get('--trained-model');
      if (modelPath && !flags.has('--build-only') && !flags.has('--contracts-only')) {
        const absolute = resolve(modelPath);
        const file = await stat(absolute);
        if (file.size <= 1024 * 1024 || file.size > 4 * 1024 ** 3)
          throw new Error('Expected a trained GGUF within the mobile 4 GiB model cap');
        requireAndroidStagingSpace(
          await required(adb, ['-s', device, 'shell', 'df', '-k', '/data']),
          file.size,
        );
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(absolute)) hash.update(bytes);
        const sha = hash.digest('hex');
        const staged = `cache/mobile-eval-${runId}.gguf`;
        const exists = await command(adb, [
          '-s',
          device,
          'shell',
          androidShellCommand(['run-as', 'com.bendyline.gezel.mobile', 'test', '-e', staged]),
        ]);
        if (exists.code === 0)
          throw new Error('This eval staging path already exists; choose a fresh run id.');
        cleanupStaged = async () => {
          await required(adb, [
            '-s',
            device,
            'shell',
            androidShellCommand(['run-as', 'com.bendyline.gezel.mobile', 'rm', '-f', staged]),
          ]);
        };
        await required(
          adb,
          [
            '-s',
            device,
            'shell',
            '-T',
            androidShellCommand([
              'run-as',
              'com.bendyline.gezel.mobile',
              'sh',
              '-c',
              `cat > ${staged}`,
            ]),
          ],
          { inputFile: absolute },
        );
        const stagedSha = (
          await required(adb, [
            '-s',
            device,
            'shell',
            androidShellCommand(['run-as', 'com.bendyline.gezel.mobile', 'sha256sum', staged]),
          ])
        ).split(/\s+/)[0];
        if (stagedSha !== sha)
          throw new Error('Android staged model digest differs from the selected trained GGUF.');
        runner.evalModelPath = `/data/user/0/com.bendyline.gezel.mobile/${staged}`;
        runner.evalDeleteStaged = '1';
        runner.evalModelSha256 = sha;
        // A catalog GGUF is staged as the download it is, so the phone runs it
        // with its catalog tuning, as the desktop and a downloading user do.
        const download = await catalogDownloadFor(sha, file.size);
        if (download) {
          runner.evalModelName = Buffer.from(download.name).toString('base64');
          runner.evalModelSource = Buffer.from(JSON.stringify(download.source)).toString('base64');
        }
        await writeFile(
          join(output, 'model-source.json'),
          `${JSON.stringify({ path: absolute, bytes: file.size, sha256: sha, stagedSha256: stagedSha, catalogId: download?.source.catalogId ?? null }, null, 2)}\n`,
        );
      }
      if (!flags.has('--build-only')) {
        const result = await withNativeFeedback(
          {
            platform: 'android',
            device,
            runId,
            output,
            adb,
            log: (line) => log.write(`${line}\n`),
          },
          () => command(adb, ['-s', device, 'shell', androidInstrumentationCommand(runner)]),
        );
        nativeCode = instrumentationSucceeded(result) ? 0 : 1;
        // This succeeds only while the original app container remains installed.
        // Stream the report; quality transcripts can exceed the log-tail limit.
        reportPath = join(output, 'android-device-report.json');
        await required(
          adb,
          [
            '-s',
            device,
            'exec-out',
            'run-as',
            'com.bendyline.gezel.mobile',
            'cat',
            `files/mobile-evals/${runId}.json`,
          ],
          { stdoutFile: reportPath },
        );
      }
    }
    if (flags.has('--build-only')) process.exitCode = nativeCode;
    else {
      if (!reportPath)
        throw new Error(
          'Native execution did not return a report; see native.log. No trial is counted as passing.',
        );
      const raw = join(output, 'native-report.json');
      await copyFile(reportPath, raw);
      const report = JSON.parse(await readFile(raw, 'utf8')) as MobileReport;
      requireMobileBuildIdentity(report.identity, {
        harnessSourceSha256: harnessSourceHash,
        productIndexSha256: productIndexHash,
      });
      const graded = await writeMobileEvaluationReport(report, output);
      console.log(graded.summary);
      process.exitCode = nativeCode === 0 && graded.success ? 0 : 1;
    }
  } catch (error) {
    await writeFile(
      join(output, 'execution-failure.json'),
      `${JSON.stringify({ runId, platform, provider, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString(), status: 'blocked', success: false }, null, 2)}\n`,
    );
    throw error;
  } finally {
    await cleanupStaged?.().catch((error) => {
      log.write(`Eval-owned staging cleanup failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
    lease?.release();
    log.end();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

/** The phone catalog's download for this GGUF, matched by content hash. */
async function catalogDownloadFor(sha256: string, sizeBytes: number) {
  // Loaded only when staging a model: CI's --contracts-only runner never builds the catalog package.
  const { BundledSource, gildeDataDir } = await import('@bendyline/gezel-catalog');
  const catalog = new BundledSource({ dataDir: gildeDataDir() });
  const model = portableCatalogModels(await catalog.list('chat-model')).find(
    (entry) => entry.source.sha256 === sha256,
  );
  return model ? { name: model.name, source: { ...model.source, sizeBytes } } : undefined;
}
