/**
 * macOS updates go through the signed PKG, not the ZIP that electron-updater
 * would otherwise use.
 *
 * Why: Gezel's macOS install is a *system* install. The PKG lays the app down
 * as root:wheel and its postinstall registers the LaunchDaemon and extracts
 * gezeld into `/Library/Application Support/Gezel/service`. electron-updater's
 * MacUpdater cannot deliver any of that — it explicitly excludes pkg/dmg
 * (`findFile(files, 'zip', ['pkg', 'dmg'])`) and hands the ZIP to Squirrel.Mac,
 * whose ShipIt runs as the logged-in user and only swaps
 * `/Applications/Gezel.app`. Three consequences, all real:
 *
 *   1. A standard (non-admin) user cannot replace the bundle at all, and
 *      electron-updater has no elevation path on macOS — Windows retries under
 *      `elevate.exe` and Linux shells out to `pkexec`/`sudo`, but Squirrel.Mac
 *      never elevates. The failure surfaces only as an 'error' event.
 *   2. Even when it succeeds, the daemon keeps running the previous release's
 *      code out of the installer-owned tree. See `systemServiceVersionSkew`
 *      in the supervisor for the banner that detects this.
 *   3. The swapped bundle ends up owned by the updating user rather than
 *      root:wheel, drifting off the postinstall's hardening.
 *
 * Handing the PKG to Installer.app fixes all three at once and needs no
 * privileged code of our own: macOS raises its standard authentication sheet,
 * and the postinstall does the rest.
 *
 * The tradeoff we accept is that a macOS update asks for an admin password.
 *
 * Everything here is dependency-injected so the verification chain is testable
 * without a network, a spawn, or a real 450 MB package.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Team ID on the Developer ID certificates the release workflow signs with. */
export const APPLE_TEAM_ID = 'JXA5M4VK3V';

/** Owner/repo behind `publish:` in electron-builder.yml. */
export const RELEASE_OWNER = 'bendyline';
export const RELEASE_REPO = 'gezel';

/** Mirrors electron-builder.yml `mac.artifactName`. */
export function macPkgAssetName(version: string, arch = 'arm64'): string {
  return `Gezel-${version}-mac-${arch}.pkg`;
}

export function releaseAssetUrl(version: string, assetName: string): string {
  return `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/v${version}/${assetName}`;
}

/**
 * Parse the release's `SHA256SUMS` (plain `sha256sum` output) into a lookup.
 * Tolerates the `*name` binary-mode marker `sha256sum` can emit.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match?.[1] && match[2]) out.set(match[2], match[1].toLowerCase());
  }
  return out;
}

export interface ExecFileResult {
  stdout: string;
}
export type ExecFileFn = (file: string, args: string[]) => Promise<ExecFileResult>;

export interface VerifyDeps {
  execFile: ExecFileFn;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export class PkgVerificationError extends Error {
  constructor(
    message: string,
    readonly step: 'digest' | 'signature' | 'notarization' | 'team' | 'gatekeeper',
  ) {
    super(message);
    this.name = 'PkgVerificationError';
  }
}

/**
 * Prove the downloaded package is the one the release published *and* that
 * macOS itself will accept it, before we hand it to a privileged installer.
 *
 * The digest check catches a truncated or substituted download. The Apple
 * checks are the real trust anchor: a package that is not Developer
 * ID-signed, not notarized, not ours, or not accepted by Gatekeeper never
 * reaches Installer.app — which would otherwise happily ask the user for an
 * administrator password on its behalf.
 */
export async function verifyMacPkg(
  pkgPath: string,
  expectedSha256: string,
  actualSha256: string,
  deps: VerifyDeps,
): Promise<void> {
  if (actualSha256 !== expectedSha256) {
    throw new PkgVerificationError(
      `Downloaded package digest ${actualSha256} does not match the published ${expectedSha256}`,
      'digest',
    );
  }

  const signature = await deps.execFile('/usr/sbin/pkgutil', ['--check-signature', pkgPath]);
  if (!/Status:\s*signed by a developer certificate issued by Apple/i.test(signature.stdout)) {
    throw new PkgVerificationError(
      `Package is not signed with a Developer ID certificate:\n${signature.stdout.trim()}`,
      'signature',
    );
  }
  if (!/Notarization:\s*trusted by the Apple notary service/i.test(signature.stdout)) {
    throw new PkgVerificationError(
      `Package is not notarized:\n${signature.stdout.trim()}`,
      'notarization',
    );
  }
  // `pkgutil` prints the Installer identity as `Developer ID Installer: Name (TEAMID)`.
  // Pinning the team is what stops a validly-signed, notarized package from
  // somebody else being installed under our name.
  if (!signature.stdout.includes(`(${APPLE_TEAM_ID})`)) {
    throw new PkgVerificationError(
      `Package is signed by a different Apple team than ${APPLE_TEAM_ID}:\n${signature.stdout.trim()}`,
      'team',
    );
  }

  const assessment = await deps
    .execFile('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=4', pkgPath])
    // spctl writes its verdict to stderr and exits non-zero on rejection.
    .catch((err: Error & { stdout?: string; stderr?: string }) => ({
      stdout: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`,
      rejected: true as const,
    }));
  if ('rejected' in assessment || !/accepted/i.test(assessment.stdout)) {
    throw new PkgVerificationError(
      `Gatekeeper rejected the package:\n${assessment.stdout.trim()}`,
      'gatekeeper',
    );
  }

  deps.logger?.info?.(
    `[updater] package verified: digest ok, Developer ID + notarized, team ${APPLE_TEAM_ID}, Gatekeeper accepted`,
  );
}

export interface StageDeps extends VerifyDeps {
  fetch: typeof globalThis.fetch;
  /** Directory to stage into. Must be user-writable — never GEZEL_HOME, which
   *  is the root-owned system directory on a machine-service install. */
  stagingDir: string;
  arch?: string;
}

export interface StagedPkg {
  path: string;
  version: string;
  sha256: string;
}

/**
 * Download the release's PKG and its SHA256SUMS, verify both, and return the
 * staged path. Throws rather than returning a partial result; the caller
 * surfaces the message to the user.
 */
export async function stageVerifiedMacPkg(version: string, deps: StageDeps): Promise<StagedPkg> {
  const assetName = macPkgAssetName(version, deps.arch ?? 'arm64');
  const sumsUrl = releaseAssetUrl(version, 'SHA256SUMS');
  const pkgUrl = releaseAssetUrl(version, assetName);

  const sumsResponse = await deps.fetch(sumsUrl);
  if (!sumsResponse.ok) {
    throw new Error(`Could not fetch SHA256SUMS for v${version} (HTTP ${sumsResponse.status})`);
  }
  const sums = parseSha256Sums(await sumsResponse.text());
  const expected = sums.get(assetName);
  if (!expected) {
    throw new Error(`Release v${version} publishes no digest for ${assetName}`);
  }

  await mkdir(deps.stagingDir, { recursive: true });
  const pkgPath = join(deps.stagingDir, assetName);
  // A partial file from an interrupted run would fail the digest check, but
  // deleting first keeps the failure mode "download again", not "diagnose a
  // stale artifact".
  await rm(pkgPath, { force: true });

  deps.logger?.info?.(`[updater] downloading ${assetName}`);
  const pkgResponse = await deps.fetch(pkgUrl);
  if (!pkgResponse.ok) {
    throw new Error(`Could not download ${assetName} (HTTP ${pkgResponse.status})`);
  }
  const bytes = Buffer.from(await pkgResponse.arrayBuffer());
  await writeFile(pkgPath, bytes);
  const actual = createHash('sha256').update(bytes).digest('hex');

  try {
    await verifyMacPkg(pkgPath, expected, actual, deps);
  } catch (err) {
    // Never leave an unverified installer on disk where a user could
    // double-click it.
    await rm(pkgPath, { force: true }).catch(() => {});
    throw err;
  }

  return { path: pkgPath, version, sha256: actual };
}

/** Digest of a file already on disk. Split out so tests can reuse it. */
export async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
