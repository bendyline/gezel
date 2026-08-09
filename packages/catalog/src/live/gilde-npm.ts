import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpStatusError, retryTransient } from '@bendyline/gezel';
import {
  DEFAULT_NPM_REGISTRY,
  downloadTarball,
  encodePackumentPath,
  extractNpmPackageTarball,
  fetchSameOrigin,
  readBoundedBody,
  validateRegistry,
} from '../install/npm-package.js';

/**
 * Registry interaction for live gilde content updates. Pure fetch/stage
 * helpers — the stateful orchestration (opt-in gate, scheduler, activation,
 * pruning) lives in the service's GildeUpdateManager. The trust anchor here
 * is registry TLS plus the registry-reported integrity hash, the same trust
 * a build-time `pnpm install` of the pin extends.
 */

export const GILDE_PACKAGE_NAME = '@bendyline/gilde';

const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 30_000;
const NETWORK_ATTEMPTS = 3;
/**
 * The abbreviated "corgi" packument: versions + dist only, a fraction of
 * the full document's size, and it keeps working as the publish count
 * grows. The q-ranked JSON fallback keeps private registries that never
 * implemented the corgi type working.
 */
const PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json, application/json;q=0.9';
/** Gilde publishes plain patch releases only — never prereleases. */
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface GildeReleaseInfo {
  version: string;
  tarballUrl: string;
  /** SRI string from the registry (`sha512-<base64>`), when present. */
  integrity?: string;
  /** Legacy sha1 hex from the registry, when present. */
  shasum?: string;
}

/**
 * Every plain `major.minor.patch` release of `@bendyline/gilde` the registry
 * knows, unsorted. Prerelease versions and releases whose tarball points off
 * the registry origin are dropped.
 */
export async function fetchGildeReleases(
  opts: { registry?: string } = {},
): Promise<GildeReleaseInfo[]> {
  const registry = validateRegistry(opts.registry ?? DEFAULT_NPM_REGISTRY);
  return retryTransient(() => fetchReleasesOnce(registry), {
    attempts: NETWORK_ATTEMPTS,
    label: `${GILDE_PACKAGE_NAME} metadata`,
  });
}

async function fetchReleasesOnce(registry: URL): Promise<GildeReleaseInfo[]> {
  const url = new URL(encodePackumentPath(GILDE_PACKAGE_NAME), registry);
  const { response, dispose } = await fetchSameOrigin(url, registry.origin, REGISTRY_TIMEOUT_MS, {
    accept: PACKUMENT_ACCEPT,
  });
  try {
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `[catalog] registry returned HTTP ${response.status}`,
      );
    }
    const raw = await readBoundedBody(response, MAX_PACKUMENT_BYTES);
    let packument: {
      versions?: Record<
        string,
        { dist?: { tarball?: string; integrity?: string; shasum?: string } }
      >;
    };
    try {
      packument = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Error('[catalog] registry returned malformed package metadata');
    }
    const releases: GildeReleaseInfo[] = [];
    for (const [version, info] of Object.entries(packument.versions ?? {})) {
      if (!RELEASE_VERSION_RE.test(version)) continue;
      const tarball = info?.dist?.tarball;
      if (typeof tarball !== 'string' || tarball.length === 0) continue;
      let parsed: URL;
      try {
        parsed = new URL(tarball, registry);
      } catch {
        continue;
      }
      if (parsed.origin !== registry.origin) continue;
      releases.push({
        version,
        tarballUrl: parsed.href,
        integrity: typeof info?.dist?.integrity === 'string' ? info.dist.integrity : undefined,
        shasum: typeof info?.dist?.shasum === 'string' ? info.dist.shasum : undefined,
      });
    }
    return releases;
  } finally {
    dispose();
  }
}

/**
 * Same-minor-line update policy: the newest release on the bundled pin's
 * `major.minor` line that is strictly newer than both the pin and the
 * currently-active live version. Null when the install is already current.
 * Line bumps deliberately ride app releases — they may carry schema changes
 * this build's loader cannot represent.
 */
export function pickGildePatchUpdate(
  releases: GildeReleaseInfo[],
  bundledPin: string,
  currentLive?: string,
): GildeReleaseInfo | null {
  if (!RELEASE_VERSION_RE.test(bundledPin)) return null;
  const [pinMajor, pinMinor] = bundledPin.split('.');
  const floor =
    currentLive &&
    RELEASE_VERSION_RE.test(currentLive) &&
    compareRelease(currentLive, bundledPin) > 0
      ? currentLive
      : bundledPin;
  let best: GildeReleaseInfo | null = null;
  for (const release of releases) {
    if (!RELEASE_VERSION_RE.test(release.version)) continue;
    const [major, minor] = release.version.split('.');
    if (major !== pinMajor || minor !== pinMinor) continue;
    if (compareRelease(release.version, floor) <= 0) continue;
    if (!best || compareRelease(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** Numeric compare for plain `major.minor.patch` strings. */
export function compareRelease(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `true` for the plain `major.minor.patch` form gilde releases use. */
export function isGildeReleaseVersion(v: string): boolean {
  return RELEASE_VERSION_RE.test(v);
}

/**
 * Download + verify + extract one gilde release into `stagingDir`. Returns
 * the extracted `package/` directory (content root is `<packageDir>/data`).
 * Refuses when the registry metadata carries no usable integrity hash. The
 * tarball is removed either way; the caller owns `stagingDir` cleanup on
 * error.
 */
export async function stageGildeVersion(opts: {
  release: GildeReleaseInfo;
  stagingDir: string;
  registry?: string;
}): Promise<{ packageDir: string }> {
  const registry = validateRegistry(opts.registry ?? DEFAULT_NPM_REGISTRY);
  const { release } = opts;
  assertVerifiable(release);
  await mkdir(opts.stagingDir, { recursive: true });
  const tarballPath = join(opts.stagingDir, 'package.tgz');
  try {
    await retryTransient(() => downloadTarball(release.tarballUrl, tarballPath, registry.origin), {
      attempts: NETWORK_ATTEMPTS,
      label: `${GILDE_PACKAGE_NAME}@${release.version} tarball`,
    });
    await verifyReleaseIntegrity(tarballPath, release);
    const packageDir = await extractNpmPackageTarball({
      tarballPath,
      destination: opts.stagingDir,
      expectedName: GILDE_PACKAGE_NAME,
      expectedVersion: release.version,
    });
    return { packageDir };
  } finally {
    await rm(tarballPath, { force: true }).catch(() => {});
  }
}

function assertVerifiable(release: GildeReleaseInfo): void {
  if (parseSha512Sri(release.integrity)) return;
  if (release.shasum && /^[0-9a-f]{40}$/i.test(release.shasum)) return;
  throw new Error(
    `[catalog] registry metadata for ${GILDE_PACKAGE_NAME}@${release.version} carries no usable integrity hash; refusing to download`,
  );
}

async function verifyReleaseIntegrity(
  tarballPath: string,
  release: GildeReleaseInfo,
): Promise<void> {
  const sri = parseSha512Sri(release.integrity);
  if (sri) {
    const actual = await hashFile(tarballPath, 'sha512', 'base64');
    if (actual !== sri) {
      throw new Error(
        `[catalog] sha512 integrity mismatch for ${GILDE_PACKAGE_NAME}@${release.version}; refusing to install`,
      );
    }
    return;
  }
  const shasum = release.shasum?.toLowerCase();
  if (shasum && /^[0-9a-f]{40}$/.test(shasum)) {
    const actual = await hashFile(tarballPath, 'sha1', 'hex');
    if (actual !== shasum) {
      throw new Error(
        `[catalog] sha1 shasum mismatch for ${GILDE_PACKAGE_NAME}@${release.version}; refusing to install`,
      );
    }
    return;
  }
  throw new Error(
    `[catalog] registry metadata for ${GILDE_PACKAGE_NAME}@${release.version} carries no usable integrity hash; refusing to install`,
  );
}

function parseSha512Sri(integrity: string | undefined): string | null {
  if (!integrity) return null;
  for (const entry of integrity.trim().split(/\s+/)) {
    if (entry.startsWith('sha512-') && entry.length > 'sha512-'.length) {
      return entry.slice('sha512-'.length);
    }
  }
  return null;
}

async function hashFile(
  path: string,
  algorithm: 'sha512' | 'sha1',
  encoding: 'base64' | 'hex',
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest(encoding);
}
