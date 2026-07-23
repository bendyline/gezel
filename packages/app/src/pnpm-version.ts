/**
 * Pinned pnpm release that ships with this Gezel version.
 *
 * Gezel bundles pnpm's executable plus its matching runtime tree so the install path for system
 * toolsets (Playwright + future additions) works on user machines without
 * a global Node/pnpm install. We pin a specific release + sha256 per
 * platform; the fetch script verifies every download against these sha's
 * and hard-fails on mismatch.
 *
 * Bumping: run `node scripts/bump-pnpm.mjs <version>` — it fetches every
 * platform binary, computes sha256s, and rewrites this file. The PR diff
 * is the audit trail. Never hand-edit a sha.
 */
export const PNPM_VERSION = '11.15.1';

/** sha256 of the version-tagged pnpm LICENSE file shipped beside the runtime. */
export const PNPM_LICENSE_SHA256 =
  '4b8e2a57502758b2d034ece9cabf19dd098c5609003ed8dbdafd085274f25bd9';

/** sha256 of the common `@pnpm/exe` tarball that supplies `dist/pnpm.mjs` and node-gyp. */
export const PNPM_RUNTIME_SHA256 =
  '4f693bffb81cc88ab816af9c684abc87a7e8b505253ed3e9b88e860e89e9dc5a';

/**
 * sha256 of each executable extracted from pnpm's official npm platform
 * package. pnpm 11's executable embeds Node but loads the common runtime tree
 * above; Intel macOS is not present and Gezel ships Apple Silicon only.
 *
 * Fill these in via `scripts/bump-pnpm.mjs`. Placeholder zeros will cause
 * a hard fail in the fetch script until populated — this is intentional.
 */
export const PNPM_SHA256: Record<string, string> = {
  'macos-arm64': '65cb7439d9b023b95d0e19d843adf14e0654426ef85ad4ecd33d58849315f669',
  'linux-x64': '5253220be9149295a49460c5e88fbfac2f78194be0a0050c7b4a65eca788a68b',
  'linux-arm64': '7f3f25eb2092e09ae1f538276dd40152bab4cbb4ba3c669e7d574c98fa01bede',
  'win-x64': '0a8b6b9d6f391bb83e868a3f951eec74fb8f745c176fce523a9359f40b20fb7b',
};

/**
 * Map node's `(process.platform, process.arch)` to our release key.
 * Returns null for unsupported combos so callers fail loudly.
 */
export function pnpmReleaseKey(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/** Staged executable filename for a given platform key (append `.exe` on Windows). */
export function pnpmAssetFilename(key: string): string {
  return key.startsWith('win-') ? `pnpm-${key}.exe` : `pnpm-${key}`;
}
