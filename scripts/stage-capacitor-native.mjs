#!/usr/bin/env node
/**
 * Stage the pinned native release's mobile SDKs into `packages/capacitor/native`.
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
 * engines beside them. Run from `publish-npm.yml` before anything publishes.
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
  verifyProducerSources,
  verifyRuntime,
} from '../packages/capacitor/scripts/stage-native.mjs';

const RELEASE_BASE = 'https://github.com/bendyline/gezel/releases/download';
const TARGETS = ['ios', 'android'];
const DOWNLOAD_ATTEMPTS = 3;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pin, read from source: the release gate runs before anything is built. */
export function parseNativePin(source) {
  const release = /export const NATIVE_ENGINE_RELEASE = '([^']+)';/.exec(source)?.[1];
  const digest = /export const SHA256SUMS_DIGEST = '([0-9a-f]{64})';/.exec(source)?.[1];
  if (!release || !digest) throw new Error('native-manifest.ts has no usable release pin');
  return { release, digest };
}

/** The hash SHA256SUMS records for one file. */
export function archiveHash(sums, name) {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  throw new Error(`SHA256SUMS does not list ${name}`);
}

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
  for (const target of TARGETS) {
    const version = await stagedVersion(join(nativeRoot, target));
    if (needsPinnedPayload(version, release, requireCurrent)) pending.push(target);
  }

  if (pending.length > 0) {
    const base = `${RELEASE_BASE}/native-v${release}`;
    const sumsBytes = await download(`${base}/SHA256SUMS`, fetchImpl);
    if (sha256(sumsBytes) !== digest) {
      throw new Error(`SHA256SUMS of native-v${release} does not match the pinned digest`);
    }
    const sums = sumsBytes.toString('utf8');
    const work = await mkdtemp(join(tmpdir(), 'gezel-capacitor-native-'));
    try {
      for (const target of pending) {
        const name = `gezel-mobile-${release}-${target}.tar.gz`;
        const archive = await download(`${base}/${name}`, fetchImpl);
        if (sha256(archive) !== archiveHash(sums, name)) {
          throw new Error(`${name} does not match SHA256SUMS`);
        }
        const file = join(work, name);
        await writeFile(file, archive);
        const extracted = await mkdtemp(join(work, `${target}-`));
        await tar.x({ file, cwd: extracted, strict: true });
        await stageNative(target, extracted, join(nativeRoot, target));
        staged.push(target);
        log(`stage-capacitor-native: staged ${target} from native-v${release}`);
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
