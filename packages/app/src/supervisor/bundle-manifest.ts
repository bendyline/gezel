import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BundleManifestResult {
  /** True when every listed file matched (or the manifest is absent). */
  ok: boolean;
  /** True when no manifest shipped — dev bundles built with GEZEL_*_SKIP. */
  skipped: boolean;
  /** Human-readable mismatch description when `ok` is false. */
  reason?: string;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => res())
      .on('error', rej);
  });
  return hash.digest('hex');
}

/**
 * Re-hash bundle files against the bundle's `sha256.txt`, written by
 * fetch-node.mjs / fetch-pnpm.mjs at build time right after the
 * pin-verified download. This extends the integrity chain (version pin →
 * verified download → staged bundle) through the install copy into
 * `<home>/bin/` — catching bundle corruption or on-disk tampering that a
 * version-string compare cannot.
 *
 * A missing manifest is not an error: older installers and dev builds
 * (GEZEL_NODE_SKIP / GEZEL_PNPM_SKIP) ship none. A present manifest that
 * doesn't cover a requested file, or a hash mismatch, is a hard failure.
 */
export async function verifyBundleManifest(
  bundleDir: string,
  files: string[],
): Promise<BundleManifestResult> {
  const manifestPath = join(bundleDir, 'sha256.txt');
  if (!existsSync(manifestPath)) {
    return { ok: true, skipped: true };
  }

  const expected = new Map<string, string>();
  for (const line of (await readFile(manifestPath, 'utf8')).split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (match?.[1] && match[2]) expected.set(match[2], match[1].toLowerCase());
  }

  for (const file of files) {
    const want = expected.get(file);
    if (!want) {
      return { ok: false, skipped: false, reason: `${file} has no entry in sha256.txt` };
    }
    const actual = await sha256File(join(bundleDir, file));
    if (actual !== want) {
      return {
        ok: false,
        skipped: false,
        reason: `${file} sha256 mismatch: expected ${want}, got ${actual}`,
      };
    }
  }
  return { ok: true, skipped: false };
}
