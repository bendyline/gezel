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
export const NODE_VERSION = '24.18.0';

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
  'macos-arm64': 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  'macos-x64': 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
  'linux-x64': '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8',
  'linux-arm64': '6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508',
  'win-x64': '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de',
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
