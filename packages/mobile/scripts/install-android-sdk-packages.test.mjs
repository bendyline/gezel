import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installAndroidSdkPackages } from './install-android-sdk-packages.mjs';

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

async function withSdkRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'gezel-android-sdk-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scripted(statuses) {
  const calls = [];
  const run = (sdkRoot, packages, env) => {
    calls.push({ sdkRoot, packages, env });
    return statuses[calls.length - 1];
  };
  return { calls, run };
}

test('a first-attempt install neither waits nor warns', async () => {
  await withSdkRoot(async (sdkRoot) => {
    const { calls, run } = scripted([0]);
    const warnings = [];
    const attempt = await installAndroidSdkPackages(['ndk;28.2.13676358'], {
      sdkRoot,
      env: { JAVA_HOME: '/jdk' },
      run,
      wait: () => assert.fail('should not wait'),
      warn: (message) => warnings.push(message),
    });
    assert.equal(attempt, 1);
    assert.deepEqual(calls, [
      { sdkRoot, packages: ['ndk;28.2.13676358'], env: { JAVA_HOME: '/jdk' } },
    ]);
    assert.deepEqual(warnings, []);
  });
});

test('a failed download is retried from clean scratch folders and announced', async () => {
  await withSdkRoot(async (sdkRoot) => {
    await mkdir(path.join(sdkRoot, '.temp'), { recursive: true });
    await writeFile(path.join(sdkRoot, '.temp', 'ndk.zip'), 'truncated');
    await mkdir(path.join(sdkRoot, '.downloadIntermediates'), { recursive: true });
    await mkdir(path.join(sdkRoot, 'platforms', 'android-36'), { recursive: true });
    const { calls, run } = scripted([1, 0]);
    const warnings = [];
    const waits = [];
    const attempt = await installAndroidSdkPackages(['ndk;28.2.13676358'], {
      sdkRoot,
      run,
      backoffMs: 10,
      wait: (ms) => waits.push(ms),
      warn: (message) => warnings.push(message),
    });
    assert.equal(attempt, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [10]);
    assert.deepEqual(warnings, ['sdkmanager attempt 1 of 3 exited with 1; retrying']);
    assert.equal(await exists(path.join(sdkRoot, '.temp')), false);
    assert.equal(await exists(path.join(sdkRoot, '.downloadIntermediates')), false);
    assert.equal(await exists(path.join(sdkRoot, 'platforms', 'android-36')), true);
  });
});

test('an install that keeps failing stops at the attempt limit', async () => {
  await withSdkRoot(async (sdkRoot) => {
    const { calls, run } = scripted([1, 1, 3]);
    const waits = [];
    await assert.rejects(
      installAndroidSdkPackages(['ndk;28.2.13676358'], {
        sdkRoot,
        run,
        backoffMs: 10,
        wait: (ms) => waits.push(ms),
        warn: () => {},
      }),
      /sdkmanager exited with 3 after 3 attempts/,
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [10, 20]);
  });
});

test('a missing sdkmanager is reported at once, not retried', async () => {
  await withSdkRoot(async (sdkRoot) => {
    let calls = 0;
    await assert.rejects(
      installAndroidSdkPackages(['ndk;28.2.13676358'], {
        sdkRoot,
        run: () => {
          calls++;
          throw Object.assign(new Error('spawn sdkmanager ENOENT'), { code: 'ENOENT' });
        },
        wait: () => assert.fail('should not wait'),
        warn: () => {},
      }),
      /ENOENT/,
    );
    assert.equal(calls, 1);
  });
});
