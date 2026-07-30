/**
 * Pinned Node.js release that ships with this Gezel version.
 *
 * Gezel bundles a standalone Node binary so features that need a node
 * runtime — sandboxed `run_nodejs_script`, and Copilot login via
 * `pnpm dlx @github/copilot login` — work on user machines without a
 * global Node install. We pin a specific release + sha256 per
 * platform; the fetch script verifies the download against these
 * sha's and hard-fails on mismatch.
 *
 * Bumping: run `node scripts/bump-node.mjs <version>` — it fetches
 * every platform asset, computes sha256s, and rewrites this file. The
 * PR diff is the audit trail. Never hand-edit a sha.
 *
 * Node.js distributes differently per platform:
 *   - Windows x64: standalone `node.exe` at /dist/v{v}/win-x64/node.exe
 *   - macOS/Linux: `.tar.gz` at /dist/v{v}/node-v{v}-{os}-{arch}.tar.gz
 *     (fetch-node extracts only the `bin/node` binary)
 *
 * The sha256 recorded here is the sha of the exact asset the fetch
 * script downloads: the raw node.exe on Windows, the whole tarball on
 * unix.
 */
export const NODE_VERSION = '24.18.1';

/** sha256 of the version-tagged Node.js LICENSE file shipped beside the runtime. */
export const NODE_LICENSE_SHA256 =
  '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5';

/**
 * sha256 of each platform asset. Keys match the suffix used by the
 * fetch/bump scripts — `macos-arm64`, `macos-x64`, `linux-x64`,
 * `linux-arm64` point at the tarball sha; `win-x64` points at the
 * raw `node.exe` sha.
 *
 * Placeholder zeros cause the fetch script to skip the download in
 * dev (same behaviour as `pnpm-version.ts`). Populate via
 * `scripts/bump-node.mjs`.
 */
export const NODE_SHA256: Record<string, string> = {
  'macos-arm64': 'eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941',
  'macos-x64': '6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec',
  'linux-x64': '9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca',
  'linux-arm64': 'df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2',
  'win-x64': 'ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582',
};

/**
 * Map node's `(process.platform, process.arch)` to our release key.
 * Returns null for unsupported combos so callers fail loudly.
 */
export function nodeReleaseKey(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'macos-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}
