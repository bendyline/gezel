import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';

export const NATIVE_FILE_MANIFEST_SCHEMA_VERSION = 2;

const SIGNATURE_EXPECTATIONS = new Set(['bendyline', 'vendor-hash-only', 'hash-only']);

/**
 * Build the source-pinnable manifest entry for one native platform directory.
 *
 * Every executable/loadable regular file is hashed. Every symlink is recorded
 * separately with its exact relative target, and must terminate at one of
 * those pinned regular files. This preserves ordinary SONAME chains without
 * allowing a link to escape the platform directory or hide an unpinned file.
 */
export async function buildNativePlatformManifest({ dir, platformKey, signatureFor }) {
  const inventory = await inventoryNativePlatform(dir, platformKey);
  const files = {};
  for (const [path, absolute] of inventory.files) {
    const info = await lstat(absolute);
    files[path] = {
      sha256: await sha256File(absolute),
      sizeBytes: info.size,
      signature: signatureFor(basename(path), path),
    };
  }
  const symlinks = Object.fromEntries(inventory.symlinks);
  const platform = { files, symlinks };
  assertNativePlatformManifest(platformKey, platform);
  return platform;
}

/**
 * Verify a native tree against a source-bundled manifest.
 *
 * The platform directory set defaults to the directories physically present
 * under `root`, which is useful for platform-scoped Electron packages. Pass
 * `platformKeys` to require an exact caller-supplied set.
 */
export async function verifyNativeFileTree({ root, manifest, expectedRelease, platformKeys }) {
  assertNativeFileManifest(manifest, { expectedRelease });

  const rootDir = resolve(root);
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`native root is not a real directory: ${rootDir}`);
  }

  const actualPlatformKeys = await platformKeysFromRoot(rootDir);
  const expectedPlatformKeys = platformKeys
    ? [...new Set(platformKeys)].sort()
    : actualPlatformKeys;
  assertSamePaths('native platform directory', expectedPlatformKeys, actualPlatformKeys);
  if (expectedPlatformKeys.length === 0) {
    throw new Error(`native root contains no platform directories: ${rootDir}`);
  }

  let fileCount = 0;
  let symlinkCount = 0;
  for (const platformKey of expectedPlatformKeys) {
    const expected = manifest.platforms[platformKey];
    if (!expected) {
      throw new Error(`native manifest has no platform entry for ${platformKey}`);
    }
    const dir = join(rootDir, platformKey);
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new Error(`${platformKey} is not a real directory`);
    }

    const actual = await inventoryNativePlatform(dir, platformKey);
    const expectedFiles = Object.keys(expected.files).sort();
    const expectedSymlinks = Object.keys(expected.symlinks).sort();
    assertSamePaths(`${platformKey} executable/loadable file`, expectedFiles, [
      ...actual.files.keys(),
    ]);
    assertSamePaths(`${platformKey} symlink`, expectedSymlinks, [...actual.symlinks.keys()]);

    for (const [path, pin] of Object.entries(expected.files)) {
      const absolute = join(dir, ...path.split('/'));
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`pinned file is missing or not regular: ${platformKey}/${path}`);
      }
      if (info.size !== pin.sizeBytes) {
        throw new Error(`size mismatch: ${platformKey}/${path}`);
      }
      const actualHash = await sha256File(absolute);
      if (actualHash !== pin.sha256.toLowerCase()) {
        throw new Error(`sha256 mismatch: ${platformKey}/${path}`);
      }
      fileCount += 1;
    }

    for (const [path, target] of Object.entries(expected.symlinks)) {
      const actualTarget = actual.symlinks.get(path);
      if (actualTarget !== target) {
        throw new Error(
          `symlink target mismatch: ${platformKey}/${path} expected ${JSON.stringify(target)}, got ${JSON.stringify(actualTarget)}`,
        );
      }
      resolveManifestSymlink(platformKey, path, expected);
      symlinkCount += 1;
    }
  }

  return {
    platformCount: expectedPlatformKeys.length,
    fileCount,
    symlinkCount,
  };
}

export function assertNativeFileManifest(
  manifest,
  { expectedRelease, allowEmptyPlatforms = false } = {},
) {
  if (!isRecord(manifest)) throw new Error('native file manifest is not an object');
  if (manifest.schemaVersion !== NATIVE_FILE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`native file manifest schema must be ${NATIVE_FILE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof manifest.release !== 'string' || manifest.release.length === 0) {
    throw new Error('native file manifest release is missing');
  }
  if (expectedRelease !== undefined && manifest.release !== expectedRelease) {
    throw new Error(
      `native file manifest release mismatch: expected ${expectedRelease}, got ${manifest.release}`,
    );
  }
  if (!isRecord(manifest.platforms)) {
    throw new Error('native file manifest platforms is not an object');
  }
  const platformEntries = Object.entries(manifest.platforms);
  if (!allowEmptyPlatforms && platformEntries.length === 0) {
    throw new Error('native file manifest contains no platform entries');
  }
  for (const [platformKey, platform] of platformEntries) {
    if (!/^[a-z0-9-]+$/.test(platformKey)) {
      throw new Error(`unsafe native platform key: ${JSON.stringify(platformKey)}`);
    }
    assertNativePlatformManifest(platformKey, platform);
  }
}

export function assertNativePlatformManifest(platformKey, platform) {
  if (!isRecord(platform)) {
    throw new Error(`${platformKey} manifest entry is not an object`);
  }
  if (!isRecord(platform.files) || Object.keys(platform.files).length === 0) {
    throw new Error(`${platformKey} contains no executable or loadable native files`);
  }
  if (!isRecord(platform.symlinks)) {
    throw new Error(`${platformKey} symlinks is not an object`);
  }

  for (const [path, pin] of Object.entries(platform.files)) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`unsafe pinned native path: ${platformKey}/${path}`);
    }
    if (!isRecord(pin)) throw new Error(`invalid native pin: ${platformKey}/${path}`);
    if (typeof pin.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(pin.sha256)) {
      throw new Error(`invalid sha256 pin: ${platformKey}/${path}`);
    }
    if (!Number.isSafeInteger(pin.sizeBytes) || pin.sizeBytes < 0) {
      throw new Error(`invalid size pin: ${platformKey}/${path}`);
    }
    if (!SIGNATURE_EXPECTATIONS.has(pin.signature)) {
      throw new Error(`invalid signature expectation: ${platformKey}/${path}`);
    }
  }

  for (const [path, target] of Object.entries(platform.symlinks)) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`unsafe pinned symlink path: ${platformKey}/${path}`);
    }
    if (Object.hasOwn(platform.files, path)) {
      throw new Error(`path is both a file and symlink: ${platformKey}/${path}`);
    }
    if (!isSafeSymlinkTarget(target)) {
      throw new Error(
        `unsafe pinned symlink target: ${platformKey}/${path} -> ${JSON.stringify(target)}`,
      );
    }
    resolveManifestSymlink(platformKey, path, platform);
  }
}

export async function platformKeysFromRoot(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const keys = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink at native platform root: ${join(root, entry.name)}`);
    }
    if (entry.isDirectory()) keys.push(entry.name);
  }
  return keys.sort();
}

export function isSafeRelativePath(path) {
  return (
    typeof path === 'string' &&
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

export function isSafeSymlinkTarget(target) {
  return isSafeRelativePath(target);
}

function resolveManifestSymlink(platformKey, start, platform) {
  const seen = new Set();
  let current = start;
  while (Object.hasOwn(platform.symlinks, current)) {
    if (seen.has(current)) {
      throw new Error(`symlink cycle in ${platformKey}: ${[...seen, current].join(' -> ')}`);
    }
    seen.add(current);
    const target = platform.symlinks[current];
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
  if (!Object.hasOwn(platform.files, current)) {
    throw new Error(
      `symlink does not terminate at a pinned regular file: ${platformKey}/${start} -> ${current}`,
    );
  }
  return current;
}

async function inventoryNativePlatform(dir, platformKey) {
  const files = new Map();
  const symlinks = new Map();

  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const path = relative(dir, absolute).replaceAll('\\', '/');
      if (!isSafeRelativePath(path)) {
        throw new Error(`unsafe native payload path: ${platformKey}/${path}`);
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (!isSafeSymlinkTarget(target)) {
          throw new Error(
            `unsafe native symlink target: ${platformKey}/${path} -> ${JSON.stringify(target)}`,
          );
        }
        symlinks.set(path, target);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        if (isLoadableNativeFile(platformKey, path, info.mode)) {
          files.set(path, absolute);
        }
      } else {
        throw new Error(`unsupported native payload entry: ${platformKey}/${path}`);
      }
    }
  };

  await visit(dir);
  return {
    files: new Map([...files].sort(([a], [b]) => a.localeCompare(b))),
    symlinks: new Map([...symlinks].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function isLoadableNativeFile(platformKey, path, mode) {
  const name = basename(path).toLowerCase();
  if (platformKey.startsWith('win32-')) return name.endsWith('.exe') || name.endsWith('.dll');
  if (platformKey.startsWith('darwin-')) {
    return name.endsWith('.dylib') || (mode & 0o111) !== 0;
  }
  return name.includes('.so') || (mode & 0o111) !== 0;
}

function assertSamePaths(label, expected, actual) {
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
