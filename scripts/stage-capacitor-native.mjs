#!/usr/bin/env node
/**
 * Stage the pinned native release's mobile SDKs and offline speech runtimes
 * into `packages/capacitor/native` (`ios`, `android`, `speech-ios`, `speech-android`).
 *
 * WHY: @bendyline/gezel-capacitor is the one npm package that carries prebuilt
 * engines, and those engines are never committed. Its `prepack` runs this, so
 * every path that packs it works unattended: `pnpm publish` in the release,
 * the rehearsal, `test:published`, `check:packages`, and a developer's
 * `pnpm validate`.
 *
 * TRUST: the same root as the desktop engine resolver. `native-manifest.ts`
 * pins the digest of the release's SHA256SUMS, SHA256SUMS names each archive's
 * hash, and each archive's own manifest hashes every file inside it.
 *
 * A payload that is already staged is left alone unless it is an older
 * release: mobile-native.yml stages the build it just made (`0.0.0-ci.*`) and
 * its consumer job must test those bytes, not the pin.
 *
 * `--require-current` is the release gate. A native release is cut from a
 * merged commit, so a pull request that changes `native/runtime` cannot pin
 * its own, and ordinary packs only warn about that drift. A published package
 * must not ship it: the plugin sources in the tarball would be newer than the
 * engines beside them. Nor may it ship without the speech runtime, which apps
 * such as DocBlocks take this package for. Run from `publish-npm.yml` before
 * anything publishes.
 *
 * Usage:
 *   node scripts/stage-capacitor-native.mjs
 *   node scripts/stage-capacitor-native.mjs --require-current
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import {
  stageNative,
  stageSpeech,
  verifyProducerSources,
  verifyRuntime,
  verifySpeech,
} from '../packages/capacitor/scripts/stage-native.mjs';

const RELEASE_BASE = 'https://github.com/bendyline/gezel/releases/download';
const TARGETS = ['ios', 'android'];
const PAYLOADS = TARGETS.flatMap((target) => [
  {
    target,
    directory: target,
    archive: (release) => `gezel-mobile-${release}-${target}.tar.gz`,
    stage: stageNative,
  },
  {
    target,
    directory: `speech-${target}`,
    speech: true,
    archive: (release) => `gezel-mobile-${release}-speech-${target}.tar.gz`,
    stage: stageSpeech,
  },
]);
const DOWNLOAD_ATTEMPTS = 3;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pin, read from source: the release gate runs before anything is built. */
export function parseNativePin(source) {
  const release = /export const NATIVE_ENGINE_RELEASE = '([^']+)';/.exec(source)?.[1];
  const digest = /export const SHA256SUMS_DIGEST = '([0-9a-f]{64})';/.exec(source)?.[1];
  if (!release || !digest) throw new Error('native-manifest.ts has no usable release pin');
  return { release, digest };
}

function listedHash(sums, name) {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  return null;
}

/** The hash SHA256SUMS records for one file. */
export function archiveHash(sums, name) {
  const hash = listedHash(sums, name);
  if (!hash) throw new Error(`SHA256SUMS does not list ${name}`);
  return hash;
}

const listsArchive = (sums, name) => listedHash(sums, name) !== null;

async function download(url, fetchImpl) {
  let failure;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failure = new Error(`HTTP ${response.status}`);
      if (response.status === 404) break;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`could not download ${url}: ${failure?.message ?? failure}`);
}

async function stagedVersion(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'sdk-manifest.json'), 'utf8')).packageVersion;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether a staged payload should be replaced by the pinned one. */
export function needsPinnedPayload(version, release, requireCurrent = false) {
  if (version === release) return false;
  if (version === null || requireCurrent) return true;
  // A prerelease is a build someone staged on purpose; an older x.y.z is a stale pin.
  return !version.includes('-');
}

/**
 * @param {{ repoRoot: string, fetchImpl?: typeof fetch, requireCurrent?: boolean, log?: (message: string) => void }} input
 * @returns {Promise<{ release: string, staged: string[] }>}
 */
export async function stagePinnedMobileSdks({
  repoRoot,
  fetchImpl = fetch,
  requireCurrent = false,
  log = console.log,
}) {
  const { release, digest } = parseNativePin(
    await readFile(join(repoRoot, 'packages/inference/src/engines/native-manifest.ts'), 'utf8'),
  );
  const nativeRoot = join(repoRoot, 'packages/capacitor/native');
  const staged = [];
  const pending = [];
  for (const payload of PAYLOADS) {
    const version = await stagedVersion(join(nativeRoot, payload.directory));
    if (needsPinnedPayload(version, release, requireCurrent)) pending.push(payload);
  }

  // Checking an older pin for a speech runtime it cannot have must not take
  // offline packing away; only the release gate insists on the answer.
  const sumsBytes =
    pending.length === 0
      ? null
      : await download(`${RELEASE_BASE}/native-v${release}/SHA256SUMS`, fetchImpl).catch(
          (error) => {
            if (requireCurrent || !pending.every((payload) => payload.speech)) throw error;
            log(
              `stage-capacitor-native: could not check native-v${release} for a speech runtime (${error.message}); offline speech stays unavailable`,
            );
            return null;
          },
        );
  if (sumsBytes) {
    const base = `${RELEASE_BASE}/native-v${release}`;
    if (sha256(sumsBytes) !== digest) {
      throw new Error(`SHA256SUMS of native-v${release} does not match the pinned digest`);
    }
    const sums = sumsBytes.toString('utf8');
    const work = await mkdtemp(join(tmpdir(), 'gezel-capacitor-native-'));
    try {
      for (const payload of pending) {
        const name = payload.archive(release);
        // Speech joined the release after native-v0.1.57. Without it the
        // package still builds and its speech status reports unavailable,
        // which a release must never ship.
        if (payload.speech && !listsArchive(sums, name)) {
          if (requireCurrent) {
            throw new Error(
              `native-v${release} has no ${payload.directory} runtime. Cut a native release and pin it with scripts/pin-native-release.mjs before publishing @bendyline/gezel-capacitor.`,
            );
          }
          log(
            `stage-capacitor-native: native-v${release} has no ${payload.directory} runtime; offline speech stays unavailable until one is staged`,
          );
          continue;
        }
        const archive = await download(`${base}/${name}`, fetchImpl);
        if (sha256(archive) !== archiveHash(sums, name)) {
          throw new Error(`${name} does not match SHA256SUMS`);
        }
        const file = join(work, name);
        await writeFile(file, archive);
        const extracted = await mkdtemp(join(work, `${payload.directory}-`));
        await tar.x({ file, cwd: extracted, strict: true });
        await payload.stage(payload.target, extracted, join(nativeRoot, payload.directory));
        staged.push(payload.directory);
        log(`stage-capacitor-native: staged ${payload.directory} from native-v${release}`);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  if (requireCurrent) {
    for (const target of TARGETS) {
      const manifest = await verifyRuntime(join(nativeRoot, target), target);
      await verifyProducerSources(manifest, repoRoot).catch((error) => {
        throw new Error(
          `${error.message}: native-v${release} predates that change. Cut a native release and pin it with scripts/pin-native-release.mjs before publishing @bendyline/gezel-capacitor.`,
        );
      });
      await verifySpeech(join(nativeRoot, `speech-${target}`), target);
    }
    log(`stage-capacitor-native: native-v${release} matches its sources`);
  }
  return { release, staged };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flags = process.argv.slice(2);
  for (const flag of flags) {
    if (flag !== '--require-current') throw new Error(`unexpected argument ${flag}`);
  }
  await stagePinnedMobileSdks({
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    requireCurrent: flags.includes('--require-current'),
  });
}
