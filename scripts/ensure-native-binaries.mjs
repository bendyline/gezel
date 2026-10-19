#!/usr/bin/env node
/**
 * Post-build hook for `pnpm app`, `pnpm app:clean` and `pnpm app:new`: make
 * sure `packages/app/native-bin/` holds the native release this checkout pins
 * (`NATIVE_ENGINE_RELEASE`), and fetch that release when it does not.
 *
 * Why: the dev supervisor hands that tree to the daemon only after the
 * service's source-pinned per-file verifier accepts it, and nothing refreshed
 * the tree when the pin moved. After a native bump every dev launch rejected
 * the checkout's binaries, said so only on Electron's console, and ran without
 * them. The check here is that same verifier with the same hash cache, so it
 * agrees with the supervisor by construction and the supervisor re-hashes
 * nothing this step already confirmed.
 *
 * Runs after `pnpm build` because the verifier and pins are read from the
 * built inference package. Fetches the pinned version, never "latest": a newer
 * release the pins do not describe would be rejected the same way.
 *
 * Never fails the launch. Offline, or with a fetch that fails, it warns and
 * the app starts with whatever is there. `GEZEL_NATIVE_FETCH_SKIP=1` opts out;
 * an operator-set `GEZEL_NATIVE_BIN_DIR` wins over this tree, so it skips too.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectPlatform } from './native-payload.mjs';

const TAG = '[pnpm app]';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeBinRoot = join(repoRoot, 'packages', 'app', 'native-bin');
const fetchScript = join(repoRoot, 'scripts', 'fetch-native-binaries.mjs');
const inferenceEngines = join(repoRoot, 'packages', 'inference', 'dist', 'engines');
const corePaths = join(repoRoot, 'packages', 'core', 'dist', 'paths.js');

/**
 * Decide and act. Every side effect is injected so the policy is testable
 * without a network or a payload.
 *
 * @returns {Promise<'skipped' | 'current' | 'fetched' | 'fetch-failed' | 'unverified'>}
 */
export async function ensureNativeBinaries({ release, hasPins, verify, fetch, log, warn }) {
  if (!hasPins) {
    log(`${TAG} no pinned native binaries for this platform at release ${release}; skipping`);
    return 'skipped';
  }

  const before = await verify();
  if (before.reused) {
    log(`${TAG} native binaries: ${before.reason}`);
    return 'current';
  }

  log(`${TAG} native binaries are not release ${release} (${brief(before.reason)}); fetching it`);
  const code = fetch(release);
  if (code !== 0) {
    warn(
      `${TAG} fetching native release ${release} failed; launching with the binaries already present. Retry with: node scripts/fetch-native-binaries.mjs --version ${release}`,
    );
    return 'fetch-failed';
  }

  const after = await verify();
  if (!after.reused) {
    warn(
      `${TAG} fetched native release ${release} but it still fails verification: ${brief(after.reason)}`,
    );
    return 'unverified';
  }
  log(`${TAG} native binaries: ${after.reason}`);
  return 'fetched';
}

function brief(reason) {
  const text = String(reason ?? '');
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function main() {
  if (process.env.GEZEL_NATIVE_FETCH_SKIP === '1') {
    console.log(`${TAG} GEZEL_NATIVE_FETCH_SKIP=1; leaving native binaries as they are`);
    return;
  }
  if (process.env.GEZEL_NATIVE_BIN_DIR) {
    console.log(
      `${TAG} GEZEL_NATIVE_BIN_DIR is set; the supervisor uses it instead of native-bin/`,
    );
    return;
  }

  let verifyNativeBinaries;
  let effectiveEngineRelease;
  let nativePayloadVerificationPath;
  try {
    ({ verifyNativeBinaries } = await import(
      pathToFileURL(join(inferenceEngines, 'electron-native-reuse.js')).href
    ));
    ({ effectiveEngineRelease } = await import(
      pathToFileURL(join(inferenceEngines, 'native-manifest.js')).href
    ));
    ({ nativePayloadVerificationPath } = await import(pathToFileURL(corePaths).href));
  } catch (error) {
    console.warn(
      `${TAG} cannot check native binaries before the inference and core packages are built: ${error?.message ?? error}`,
    );
    return;
  }

  const release = effectiveEngineRelease();
  const manifest = JSON.parse(
    readFileSync(join(inferenceEngines, 'native-file-manifest.json'), 'utf8'),
  );
  const platform = detectPlatform();
  const hasPins =
    platform !== null &&
    manifest.release === release &&
    Object.keys(manifest.platforms ?? {}).some(
      (key) => key === platform || key.startsWith(`${platform}-`),
    );
  const home = process.env.GEZEL_HOME ?? join(homedir(), '.gezel-dev');

  await ensureNativeBinaries({
    release,
    hasPins,
    verify: () =>
      verifyNativeBinaries({
        candidates: [nativeBinRoot],
        allowStandaloneMacPayload: true,
        cacheFile: nativePayloadVerificationPath(home),
      }),
    fetch: (version) =>
      spawnSync(process.execPath, [fetchScript, '--version', version], {
        cwd: repoRoot,
        stdio: 'inherit',
      }).status ?? 1,
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.warn(`${TAG} native binary check failed: ${error?.message ?? error}`);
  });
}
