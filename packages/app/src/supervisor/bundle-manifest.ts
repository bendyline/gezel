import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BundleManifestResult {
  /** True when every listed file matched (or the manifest is absent). */
  ok: boolean;
  /** True when no manifest shipped — dev bundles built with GEZEL_*_SKIP. */
  skipped: boolean;
  /** Human-readable mismatch description when `ok` is false. */
  reason?: string;
}

// Read buffers are reused, never allocated per chunk. This runs in Electron's
// main process on every launch, where a read stream's per-chunk buffer is slow
// to allocate and the garbage it leaves stalls the loop: hashing node.exe,
// duckdb and the MXC launcher this way cost seconds of GC on the splash screen
// for ~140 MB of input. Pooled so concurrent callers never share one.
const HASH_READ_BUFFER_BYTES = 1024 * 1024;
const hashBuffers: Buffer[] = [];

export async function sha256File(path: string): Promise<string> {
  const buffer = hashBuffers.pop() ?? Buffer.allocUnsafe(HASH_READ_BUFFER_BYTES);
  try {
    const handle = await open(path, 'r');
    try {
      const hash = createHash('sha256');
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return hash.digest('hex');
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  } finally {
    hashBuffers.push(buffer);
  }
}

/**
 * The digests a bundle's `sha256.txt` declares, by file, or null when the
 * bundle shipped none. Reading it costs nothing next to hashing, which is
 * what lets a stamped install be checked without touching the bundle's bytes.
 */
export async function readBundleManifest(bundleDir: string): Promise<Map<string, string> | null> {
  const manifestPath = join(bundleDir, 'sha256.txt');
  if (!existsSync(manifestPath)) return null;
  const expected = new Map<string, string>();
  for (const line of (await readFile(manifestPath, 'utf8')).split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (match?.[1] && match[2]) expected.set(match[2], match[1].toLowerCase());
  }
  return expected;
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
  const expected = await readBundleManifest(bundleDir);
  if (!expected) {
    return { ok: true, skipped: true };
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
