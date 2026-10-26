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
export const NODE_VERSION = '24.22.1';

/** sha256 of the version-tagged Node.js LICENSE file shipped beside the runtime. */
export const NODE_LICENSE_SHA256 =
  '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';

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
  'macos-arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'macos-x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'linux-x64': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  'linux-arm64': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  'win-x64': 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
  'win-arm64': '8bea91dc437fe01e7d92ef0efc6c9eaf654369aaba9b2d3e9841552ea7b95a00',
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
  if (platform === 'win32') {
    if (arch === 'x64') return 'win-x64';
    if (arch === 'arm64') return 'win-arm64';
  }
  return null;
}
