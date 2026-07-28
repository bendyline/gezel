import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { resolvePlatformKey } from '@bendyline/gezel/native';
import pinnedManifestJson from './native-file-manifest.json';
import { effectiveEngineRelease } from './native-manifest.js';
import { verifyCodeSignature } from './signature.js';

type FileSignatureExpectation = 'bendyline' | 'vendor-hash-only' | 'hash-only';

interface NativeFilePin {
  sha256: string;
  sizeBytes: number;
  signature: FileSignatureExpectation;
}

interface NativeFileManifest {
  schemaVersion: 1;
  release: string;
  platforms: Record<string, { files: Record<string, NativeFilePin> }>;
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
}

/**
 * Adopt Electron's extracted native payload only when every executable and
 * loadable library matches the CLI's source-bundled per-file pins.
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
  if (manifest.schemaVersion !== 1 || manifest.release !== release) {
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
    try {
      await verifyCandidate({
        root: candidate,
        platform,
        entries: platformEntries,
        verifySignature: opts.verifySignature ?? verifyCodeSignature,
      });
      process.env.GEZEL_NATIVE_BIN_DIR = resolve(candidate);
      return {
        reused: true,
        nativeBinDir: resolve(candidate),
        reason: `verified Electron native release ${release}`,
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
  entries: Array<[string, { files: Record<string, NativeFilePin> }]>;
  verifySignature: typeof verifyCodeSignature;
}): Promise<void> {
  const root = resolve(opts.root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('native-bin root is not a real directory');
  }

  for (const [platformKey, platformPin] of opts.entries) {
    const platformDir = join(root, platformKey);
    const actualNativeFiles = await listLoadableFiles(platformDir, opts.platform);
    const expectedPaths = new Set(Object.keys(platformPin.files));
    for (const actual of actualNativeFiles) {
      if (!expectedPaths.has(actual)) {
        throw new Error(`unexpected executable/loadable file: ${platformKey}/${actual}`);
      }
    }

    for (const [relativePath, pin] of Object.entries(platformPin.files)) {
      if (!isSafeRelativePath(relativePath)) {
        throw new Error(`unsafe pinned native path: ${relativePath}`);
      }
      const absolute = join(platformDir, ...relativePath.split('/'));
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`pinned file is missing or not regular: ${platformKey}/${relativePath}`);
      }
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
          expectedPublisher: 'Bendyline LLC',
        });
        if (!outcome.accepted) {
          throw new Error(
            `signature rejected: ${platformKey}/${relativePath} (${outcome.result.detail ?? outcome.result.status})`,
          );
        }
      }
    }
  }

  if (opts.platform === 'darwin') {
    const appBundle = enclosingMacApp(root);
    if (!appBundle) throw new Error('native payload is not inside a macOS app bundle');
    const outcome = await opts.verifySignature(appBundle, {
      platform: 'darwin',
      policy: 'require',
      expectedPublisher: 'Bendyline LLC',
      requireNotarizedApp: true,
    });
    if (!outcome.accepted) {
      throw new Error(`parent app signature/notarization rejected: ${outcome.result.detail ?? ''}`);
    }
  }
}

async function listLoadableFiles(root: string, platform: NodeJS.Platform): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink in native payload: ${relative(root, absolute)}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        if (isLoadableNativeFile(platform, entry.name, info.mode)) {
          out.push(relative(root, absolute).split(sep).join('/'));
        }
      }
    }
  };
  await visit(root);
  return out.sort();
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
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function enclosingMacApp(path: string): string | null {
  const normalized = path.split(sep).join('/');
  const marker = '.app/Contents/';
  const index = normalized.indexOf(marker);
  return index < 0 ? null : normalized.slice(0, index + 4);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
