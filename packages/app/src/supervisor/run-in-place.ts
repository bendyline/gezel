import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundleManifest } from './bundle-manifest.js';
import { redirectAsarToUnpacked } from './extract-bundle.js';

/**
 * Resolve a bundled runtime WHERE IT SHIPPED, instead of copying it into
 * `~/.gezel/bin/` first.
 *
 * The direct-download builds extract node, pnpm and DuckDB out of the app and
 * run them from the user's home. That is right there: the daemon outlives the
 * app, an npm-installed `gezeld` shares the same copies, and the home is
 * writable by definition.
 *
 * A Mac App Store build cannot do it and must not try. App Review guideline
 * 2.4.5 expects a store app to be self-contained and not to install code
 * outside its bundle, and copying an executable out of the bundle to run it is
 * the shape that rule describes — even when the bytes came from the signed
 * package. Under the sandbox it is also pointless: `$HOME` is the app's own
 * container, so the copy buys no sharing with anything, and every copied
 * Mach-O would need its signature and inherit entitlements to survive the
 * copy, which is one more way for a launch to fail for reasons that look
 * nothing like a signing problem.
 *
 * So the store lane resolves in place. The integrity chain is unchanged and in
 * fact shorter: the same `sha256.txt` the installer verified now authenticates
 * the bytes we are about to execute, with no copy in between that could differ
 * from what was checked.
 *
 * Windows MSIX keeps extracting to the home directory as before — it is full
 * trust, `%USERPROFILE%` is real, and the sharing with an npm-installed daemon
 * is worth having.
 */
export interface InPlaceRuntime {
  /** Absolute path to the executable/entrypoint, or null when nothing shipped. */
  path: string | null;
  /** Shipped version from the bundle's `version.txt`, when present. */
  version: string | null;
  /** True only when the shipped manifest authenticated these exact bytes. */
  verified: boolean;
  /** Why an unverified or missing result came back, for the launch log. */
  reason?: string;
}

export interface ResolveInPlaceOptions {
  /** The bundle directory as shipped, e.g. `app.asar.unpacked/dist/node-bundle`. */
  bundleDir: string;
  /** Entry relative to `bundleDir` — the thing that will actually be executed. */
  entry: string;
  /**
   * Every file the manifest must authenticate. Defaults to just `entry`.
   * pnpm needs more than its entrypoint: the entry is a shim that loads the
   * real CLI, so verifying only the shim would leave the code that does the
   * work unchecked.
   */
  manifestFiles?: string[];
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export async function resolveRuntimeInPlace(opts: ResolveInPlaceOptions): Promise<InPlaceRuntime> {
  const { bundleDir, entry, logger } = opts;

  if (!existsSync(bundleDir)) {
    return { path: null, version: null, verified: false, reason: `no bundle at ${bundleDir}` };
  }
  const entryPath = join(bundleDir, entry);
  if (!existsSync(entryPath)) {
    // A bundle directory with no payload is what a build with
    // GEZEL_NODE_SKIP=1 (or a placeholder pin) leaves behind. Not an error —
    // just nothing to run.
    return {
      path: null,
      version: null,
      verified: false,
      reason: `bundle at ${bundleDir} has no ${entry}`,
    };
  }

  const version = await readVersion(bundleDir);
  const integrity = await verifyBundleManifest(bundleDir, opts.manifestFiles ?? [entry]);
  if (!integrity.ok) {
    // Deliberately returns rather than throws, and returns `verified: false`
    // with the path withheld. The caller fails closed on that in a store
    // build; leaving the path out means no branch can accidentally run
    // bytes that just failed their own manifest.
    logger?.warn?.(`[supervisor] in-place runtime integrity check failed: ${integrity.reason}`);
    return { path: null, version, verified: false, reason: integrity.reason ?? 'integrity failed' };
  }
  if (integrity.skipped) {
    // No manifest shipped. Honest about it rather than claiming verification
    // that did not happen — the caller decides whether that is acceptable.
    return {
      path: entryPath,
      version,
      verified: false,
      reason: 'bundle shipped no sha256.txt manifest',
    };
  }

  logger?.info?.(
    `[supervisor] using bundled runtime in place: ${entryPath}${version ? ` (v${version})` : ''}`,
  );
  return { path: entryPath, version, verified: true };
}

async function readVersion(bundleDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(bundleDir, 'version.txt'), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Whether this launch must run its bundled runtimes in place.
 *
 * True only for a store build on macOS. The Windows store build is full trust
 * with a real user profile, so it keeps the extract-to-home path and the
 * sharing that comes with it; there is no store rule against it there.
 */
export function shouldRunRuntimesInPlace(args: {
  storeProfile: boolean;
  platform?: NodeJS.Platform;
}): boolean {
  return args.storeProfile && (args.platform ?? process.platform) === 'darwin';
}

/**
 * The service tree as it ships inside the app bundle, for the store lane that
 * must not extract it.
 *
 * The direct-download builds ship the service as `service-bundle.tar.gz` and
 * unpack it into `~/.gezel/service/` on first launch. That exists for a
 * Windows reason: Defender real-time-scans each extracted file synchronously,
 * so unpacking one archive instead of ~100k loose files is the difference
 * between a thirty-minute install and a few seconds.
 *
 * A MAS build has neither the problem nor the permission. `pnpm deploy` leaves
 * the complete tree at `dist/service-bundle/` on its way to producing the
 * tarball, so the store lane ships THAT and imports it where it sits — no
 * unpack step, no second copy of executable code in the container, and the
 * native addons inside keep the Apple Distribution signature the MAS lane gave
 * them, which is what library validation will check.
 */
export function inBundleServiceTree(mainMetaUrl: string): string | null {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  const tree = redirectAsarToUnpacked(resolve(mainDir, 'service-bundle'));
  return existsSync(join(tree, 'dist', 'index.js')) ? tree : null;
}
