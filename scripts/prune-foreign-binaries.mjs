/**
 * Drop native binaries for platforms and architectures the bundle will never
 * run on.
 *
 * Several dependencies publish every platform's prebuilt binaries in a single
 * package rather than as per-platform optional deps — `onnxruntime-node` and
 * `node-pty` are the big ones. The v1.26209.11 macOS installer carried 318 MB
 * of win32/linux binaries plus 35 MB of darwin-x64: 29% of the uncompressed
 * service bundle could not execute on the arm64 Mac it shipped to.
 *
 * Every release job builds on a runner matching its target (arm64 macOS,
 * x64/arm64 Linux, x64 Windows), so the build host's own platform/arch is the
 * right thing to keep. `GEZEL_BUNDLE_PLATFORM` / `GEZEL_BUNDLE_ARCH` override
 * that if a cross-build ever appears.
 *
 * Deliberately conservative. Only three directory shapes are pruned:
 *
 *   <platform>/<arch>/      onnxruntime-node/bin/napi-v6/darwin/arm64/
 *   <platform>-<arch>/      node-pty/prebuilds/darwin-arm64/
 *   <pkg>-<platform>-<arch>/ @reflink/reflink-darwin-x64/
 *
 * A bare `x64`/`arm64` directory is pruned only when its parent is a platform
 * directory we recognise — otherwise an unrelated `x64` folder could be hit.
 * Anything unrecognised is left alone: shipping a few extra megabytes is a far
 * cheaper mistake than deleting a binary the app loads lazily.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PLATFORMS = new Set(['darwin', 'linux', 'win32', 'android', 'freebsd', 'sunos', 'aix']);
const ARCHES = new Set(['x64', 'arm64', 'ia32', 'arm', 'armv7l', 'ppc64', 's390x', 'riscv64']);

/**
 * Decide the fate of one directory, given its own name and its parent's.
 * Returns null to keep, or a reason string to prune.
 */
export function pruneReason(name, parentName, target) {
  // <platform>-<arch>, e.g. darwin-x64 / win32-arm64
  const hyphen = name.split('-');
  if (hyphen.length === 2 && PLATFORMS.has(hyphen[0]) && ARCHES.has(hyphen[1])) {
    const [platform, arch] = hyphen;
    if (platform !== target.platform) return `foreign platform (${platform})`;
    if (arch !== target.arch) return `foreign arch (${arch})`;
    return null;
  }
  // A platform-qualified package under a scope, e.g.
  // @reflink/reflink-darwin-x64 or @reflink/reflink-win32-x64-msvc.
  // Requiring a scoped parent avoids treating arbitrary application
  // directories such as docs-darwin-x64 as native package variants.
  const qualifiedPackage =
    parentName.startsWith('@') &&
    /^(?:.+-)(darwin|linux|win32|android|freebsd|sunos|aix)-(x64|arm64|ia32|arm|armv7l|ppc64|s390x|riscv64)(?:-[a-z0-9_]+)*$/.exec(
      name,
    );
  if (qualifiedPackage) {
    const [, platform, arch] = qualifiedPackage;
    if (platform !== target.platform) return `foreign platform (${platform})`;
    if (arch !== target.arch) return `foreign arch (${arch})`;
    return null;
  }
  // A platform directory: darwin/ linux/ win32/
  if (PLATFORMS.has(name)) {
    return name === target.platform ? null : `foreign platform (${name})`;
  }
  // A bare arch directory, only meaningful directly under a platform we kept.
  if (ARCHES.has(name) && PLATFORMS.has(parentName)) {
    return name === target.arch ? null : `foreign arch (${name})`;
  }
  return null;
}

async function directorySize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile())
      total += await stat(full).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

/**
 * Prune foreign-platform directories under `root`. Returns
 * `{ removed, bytes }`. Pass `dryRun` to measure without deleting.
 */
export async function pruneForeignBinaries(root, options = {}) {
  const target = {
    platform: options.platform ?? process.env.GEZEL_BUNDLE_PLATFORM ?? process.platform,
    arch: options.arch ?? process.env.GEZEL_BUNDLE_ARCH ?? process.arch,
  };
  const dryRun = options.dryRun ?? false;
  const removed = [];
  let bytes = 0;

  async function walk(dir, parentName) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // Never traverse or delete through a symlink — the bundle's own
      // symlink pruning runs separately and owns that concern.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const reason = pruneReason(entry.name, parentName, target);
      if (reason) {
        const size = await directorySize(full);
        bytes += size;
        removed.push({ path: full, reason, size });
        if (!dryRun) await rm(full, { recursive: true, force: true });
        continue;
      }
      await walk(full, entry.name);
    }
  }

  await walk(root, '');
  return { removed, bytes, target };
}

/** Prune and log a one-line summary. Used by the service-bundle build. */
export async function pruneForeignBinariesWithReport(root, options = {}) {
  const { removed, bytes, target } = await pruneForeignBinaries(root, options);
  if (removed.length === 0) {
    console.log(`[prune-foreign] nothing to prune for ${target.platform}-${target.arch}`);
    return { removed, bytes };
  }
  console.log(
    `[prune-foreign] removed ${removed.length} foreign directories ` +
      `(${(bytes / 1048576).toFixed(1)} MB) — keeping ${target.platform}-${target.arch}`,
  );
  return { removed, bytes };
}
