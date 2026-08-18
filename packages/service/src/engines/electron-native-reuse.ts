import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { resolvePlatformKey } from '@bendyline/gezel/native';
import pinnedManifestJson from './native-file-manifest.json';
import { effectiveEngineRelease } from './native-manifest.js';
import { BENDYLINE_APPLE_TEAM_ID, BENDYLINE_PUBLISHER, verifyCodeSignature } from './signature.js';

type FileSignatureExpectation = 'bendyline' | 'vendor-hash-only' | 'hash-only';

interface NativeFilePin {
  sha256: string;
  sizeBytes: number;
  signature: FileSignatureExpectation;
}

interface NativePlatformPin {
  files: Record<string, NativeFilePin>;
  symlinks: Record<string, string>;
}

interface NativeFileManifest {
  schemaVersion: 2;
  release: string;
  platforms: Record<string, NativePlatformPin>;
}

const pinnedManifest = pinnedManifestJson as NativeFileManifest;

export interface ElectronNativeReuseResult {
  reused: boolean;
  nativeBinDir?: string;
  reason: string;
}

export interface ElectronNativeReuseOptions {
  candidates: string[];
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
  manifest?: NativeFileManifest;
  verifySignature?: typeof verifyCodeSignature;
  /**
   * Accept an exactly pinned standalone macOS native release tree without an
   * enclosing Electron app. Intended for the development checkout populated
   * by `fetch-native-binaries.mjs`; installed Electron payloads must leave
   * this false so their parent app is also signature/notarization checked.
   */
  allowStandaloneMacPayload?: boolean;
}

/**
 * Adopt Electron's extracted native payload, or an explicitly allowed
 * standalone development payload, only when every executable and loadable
 * library matches the CLI's source-bundled per-file pins.
 *
 * A manifest found beside the Electron app is never trusted. The expected
 * file set and hashes come from this package, which pin-native-release.mjs
 * updates from the separately published native release.
 */
export async function reuseVerifiedElectronNativeBinaries(
  opts: ElectronNativeReuseOptions,
): Promise<ElectronNativeReuseResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const release = opts.release ?? effectiveEngineRelease();
  const manifest = opts.manifest ?? pinnedManifest;
  if (manifest.schemaVersion !== 2 || manifest.release !== release) {
    return {
      reused: false,
      reason: `no per-file native pins for release ${release}`,
    };
  }

  const baseKey = resolvePlatformKey(platform, arch);
  if (!baseKey) {
    return { reused: false, reason: `unsupported platform ${platform}/${arch}` };
  }
  const platformEntries = Object.entries(manifest.platforms).filter(
    ([key]) => key === baseKey || key.startsWith(`${baseKey}-`),
  );
  if (platformEntries.length === 0) {
    return {
      reused: false,
      reason: `release ${release} has no pinned files for ${baseKey}`,
    };
  }

  const failures: string[] = [];
  for (const candidate of opts.candidates) {
    const startedAt = Date.now();
    try {
      await verifyCandidate({
        root: candidate,
        platform,
        entries: platformEntries,
        verifySignature: opts.verifySignature ?? verifyCodeSignature,
        allowStandaloneMacPayload: opts.allowStandaloneMacPayload === true,
      });
      process.env.GEZEL_NATIVE_BIN_DIR = resolve(candidate);
      return {
        reused: true,
        nativeBinDir: resolve(candidate),
        // The elapsed time is load-bearing diagnostics, not decoration: this
        // is pre-bind boot work whose cost scales with the payload, and on a
        // CUDA host it is the largest single read the daemon ever does at
        // startup. Without it in the log there is nothing to attribute a slow
        // launch to.
        reason: `verified ${
          opts.allowStandaloneMacPayload ? 'standalone' : 'Electron'
        } native release ${release} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    reused: false,
    reason:
      failures.length > 0
        ? failures.join('; ')
        : 'no Electron native payload candidate was installed',
  };
}

async function verifyCandidate(opts: {
  root: string;
  platform: NodeJS.Platform;
  entries: Array<[string, NativePlatformPin]>;
  verifySignature: typeof verifyCodeSignature;
  allowStandaloneMacPayload: boolean;
}): Promise<void> {
  const root = resolve(opts.root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('native-bin root is not a real directory');
  }

  for (const [platformKey, platformPin] of opts.entries) {
    const platformDir = join(root, platformKey);
    const platformInfo = await lstat(platformDir);
    if (!platformInfo.isDirectory() || platformInfo.isSymbolicLink()) {
      throw new Error(`native platform root is not a real directory: ${platformKey}`);
    }
    if (!isRecord(platformPin.files) || !isRecord(platformPin.symlinks)) {
      throw new Error(`invalid native manifest entry: ${platformKey}`);
    }
    const actual = await listNativeEntries(platformDir, opts.platform);
    assertSamePaths(
      `${platformKey} executable/loadable file`,
      Object.keys(platformPin.files),
      actual.files,
    );
    assertSamePaths(`${platformKey} symlink`, Object.keys(platformPin.symlinks), [
      ...actual.symlinks.keys(),
    ]);

    // Hash several files at once. This runs on the boot path of every daemon
    // — before the HTTP bind — and on a CUDA host the pinned set is dominated
    // by NVIDIA redistributables: libcublasLt.so alone is 717 MB, libcublas.so
    // another 111 MB. Serially, that is a gigabyte of streaming SHA-256 in
    // front of the first request on every single launch. The work is I/O bound
    // on a handful of very large files, so a small pool collapses most of it
    // into the time of the largest member; a bigger pool just queues seeks.
    // Semantics are unchanged: any rejection still fails the candidate, and
    // the first one to fail wins the message.
    await mapWithConcurrency(Object.entries(platformPin.files), 4, async ([relativePath, pin]) => {
      if (!isSafeRelativePath(relativePath)) {
        throw new Error(`unsafe pinned native path: ${relativePath}`);
      }
      const absolute = join(platformDir, ...relativePath.split('/'));
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`pinned file is missing or not regular: ${platformKey}/${relativePath}`);
      }
      // Cheap discriminator first: a size mismatch means the sha cannot match,
      // so a wrong release is rejected without reading a byte of it.
      if (info.size !== pin.sizeBytes) {
        throw new Error(`size mismatch: ${platformKey}/${relativePath}`);
      }
      const actualSha = await sha256File(absolute);
      if (actualSha !== pin.sha256.toLowerCase()) {
        throw new Error(`sha256 mismatch: ${platformKey}/${relativePath}`);
      }

      if (pin.signature === 'bendyline' && opts.platform !== 'linux') {
        const outcome = await opts.verifySignature(absolute, {
          platform: opts.platform,
          policy: 'require',
          expectedPublisher: BENDYLINE_PUBLISHER,
          expectedAppleTeamId: BENDYLINE_APPLE_TEAM_ID,
        });
        if (!outcome.accepted) {
          throw new Error(
            `signature rejected: ${platformKey}/${relativePath} (${outcome.result.detail ?? outcome.result.status})`,
          );
        }
      }
    });

    for (const [relativePath, target] of Object.entries(platformPin.symlinks)) {
      if (!isSafeRelativePath(relativePath)) {
        throw new Error(`unsafe pinned symlink path: ${relativePath}`);
      }
      if (!isSafeSymlinkTarget(target)) {
        throw new Error(
          `unsafe pinned symlink target: ${platformKey}/${relativePath} -> ${JSON.stringify(target)}`,
        );
      }
      const actualTarget = actual.symlinks.get(relativePath);
      if (actualTarget !== target) {
        throw new Error(
          `symlink target mismatch: ${platformKey}/${relativePath} expected ${JSON.stringify(target)}, got ${JSON.stringify(actualTarget)}`,
        );
      }
      resolvePinnedSymlink(platformKey, relativePath, platformPin);
    }
  }

  if (opts.platform === 'darwin' && !opts.allowStandaloneMacPayload) {
    const appBundle = enclosingMacApp(root);
    if (!appBundle) throw new Error('native payload is not inside a macOS app bundle');
    const outcome = await opts.verifySignature(appBundle, {
      platform: 'darwin',
      policy: 'require',
      expectedPublisher: BENDYLINE_PUBLISHER,
      expectedAppleTeamId: BENDYLINE_APPLE_TEAM_ID,
      requireNotarizedApp: true,
    });
    if (!outcome.accepted) {
      throw new Error(`parent app signature/notarization rejected: ${outcome.result.detail ?? ''}`);
    }
  }
}

async function listNativeEntries(
  root: string,
  platform: NodeJS.Platform,
): Promise<{ files: string[]; symlinks: Map<string, string> }> {
  const files: string[] = [];
  const symlinks = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (!isSafeRelativePath(path)) {
        throw new Error(`unsafe native payload path: ${path}`);
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (!isSafeSymlinkTarget(target)) {
          throw new Error(
            `unsafe symlink target in native payload: ${path} -> ${JSON.stringify(target)}`,
          );
        }
        symlinks.set(path, target);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        if (isLoadableNativeFile(platform, entry.name, info.mode)) {
          files.push(path);
        }
      } else {
        throw new Error(`unsupported native payload entry: ${path}`);
      }
    }
  };
  await visit(root);
  return {
    files: files.sort(),
    symlinks: new Map([...symlinks].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Run `worker` over `items` with at most `limit` in flight, rejecting with the
 * first failure. Workers already in flight are allowed to settle; nothing here
 * mutates state, so an abandoned hash is inert.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function isLoadableNativeFile(platform: NodeJS.Platform, name: string, mode: number): boolean {
  const lower = basename(name).toLowerCase();
  if (platform === 'win32') return lower.endsWith('.exe') || lower.endsWith('.dll');
  if (platform === 'darwin') return lower.endsWith('.dylib') || (mode & 0o111) !== 0;
  return lower.includes('.so') || (mode & 0o111) !== 0;
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every(
        (segment) =>
          segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'),
      )
  );
}

function isSafeSymlinkTarget(target: unknown): target is string {
  return typeof target === 'string' && isSafeRelativePath(target);
}

function resolvePinnedSymlink(
  platformKey: string,
  start: string,
  platformPin: NativePlatformPin,
): string {
  const seen = new Set<string>();
  let current = start;
  while (Object.hasOwn(platformPin.symlinks, current)) {
    if (seen.has(current)) {
      throw new Error(`symlink cycle in ${platformKey}: ${[...seen, current].join(' -> ')}`);
    }
    seen.add(current);
    const target = platformPin.symlinks[current];
    if (!isSafeSymlinkTarget(target)) {
      throw new Error(
        `unsafe pinned symlink target: ${platformKey}/${current} -> ${JSON.stringify(target)}`,
      );
    }
    current = posix.normalize(posix.join(posix.dirname(current), target));
    if (!isSafeRelativePath(current)) {
      throw new Error(
        `symlink escapes platform directory: ${platformKey}/${start} -> ${JSON.stringify(target)}`,
      );
    }
  }
  if (!Object.hasOwn(platformPin.files, current)) {
    throw new Error(
      `symlink does not terminate at a pinned regular file: ${platformKey}/${start} -> ${current}`,
    );
  }
  return current;
}

function assertSamePaths(label: string, expected: string[], actual: string[]): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (
    expectedSorted.length !== actualSorted.length ||
    expectedSorted.some((value, index) => value !== actualSorted[index])
  ) {
    const missing = expectedSorted.filter((path) => !actualSorted.includes(path));
    const unexpected = actualSorted.filter((path) => !expectedSorted.includes(path));
    throw new Error(
      `${label} set mismatch` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
        `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function enclosingMacApp(path: string): string | null {
  const normalized = path.split(sep).join('/');
  const marker = '.app/Contents/';
  const index = normalized.indexOf(marker);
  return index < 0 ? null : normalized.slice(0, index + 4);
}

// Big read buffer so hashing a native binary doesn't starve inside the busy
// daemon event loop (a 64 KB stream yields ~100k times and queues behind other
// work). Engines is a lower layer than models, so this mirrors models'
// MODEL_HASH_READ_BUFFER_BYTES rather than importing it.
const HASH_READ_BUFFER_BYTES = 16 * 1024 * 1024;

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: HASH_READ_BUFFER_BYTES });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
