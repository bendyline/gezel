import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Google's download host sometimes ends a transfer early, and sdkmanager then
// unzips the short file and fails with "Error reading Zip content from a
// SeekableByteChannel". On 2026-11-12 that failed a mobile-native Android job
// whose code had passed an hour earlier, so installs get a few attempts.
const SCRATCH_DIRS = ['.temp', '.downloadIntermediates'];

function runSdkmanager(sdkRoot, packages, env) {
  const command = path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager');
  const result = spawnSync(command, packages, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status;
}

/** Install pinned SDK packages, retrying a failed attempt. A retry first clears
 * sdkmanager's scratch folders so it cannot reuse the bytes that failed, and is
 * announced as a workflow warning so a flake it absorbed stays visible. */
export async function installAndroidSdkPackages(packages, options = {}) {
  const {
    sdkRoot = process.env.ANDROID_HOME,
    env = process.env,
    attempts = 3,
    backoffMs = 15_000,
    run = runSdkmanager,
    wait = delay,
    warn = (message) => console.log(`::warning title=Android SDK install retried::${message}`),
  } = options;
  if (!sdkRoot) throw new Error('ANDROID_HOME is not set');
  for (let attempt = 1; ; attempt++) {
    const status = run(sdkRoot, packages, env);
    if (status === 0) return attempt;
    if (attempt >= attempts) {
      throw new Error(`sdkmanager exited with ${status} after ${attempts} attempts`);
    }
    warn(`sdkmanager attempt ${attempt} of ${attempts} exited with ${status}; retrying`);
    for (const dir of SCRATCH_DIRS) {
      await rm(path.join(sdkRoot, dir), { recursive: true, force: true });
    }
    await wait(backoffMs * attempt);
  }
}
