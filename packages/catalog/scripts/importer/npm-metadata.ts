import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from './fs-utils.js';
import { HttpError, fetchWithRetry } from './http.js';
import type { NpmPackageFacts } from './mapper.js';

const NPM_REGISTRY = 'https://registry.npmjs.org';

interface NpmPackumentVersion {
  name: string;
  version: string;
  description?: string;
  license?: string | { type?: string };
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  type?: 'commonjs' | 'module';
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
  };
}

interface NpmPackument {
  name: string;
  versions?: Record<string, NpmPackumentVersion>;
  'dist-tags'?: Record<string, string>;
}

export interface NpmResolution {
  facts: NpmPackageFacts;
  /** SPDX license id read from package.json — useful as a fallback for the license resolver. */
  licenseSpdx: string | null;
  /** Set when we couldn't pin a sane entry; calling code should skip the entry. */
  warnings: string[];
}

export interface NpmResolverOptions {
  /** Disk cache root. Falsy = no cache (used in unit tests). */
  cacheDir?: string;
  /** Custom fetcher (tests). */
  fetchImpl?: typeof fetch;
}

export class NpmMetadataResolver {
  constructor(private readonly opts: NpmResolverOptions = {}) {}

  /**
   * Resolve sha256 + entry path for a given (package, version). Both
   * are derived deterministically: sha256 by hashing the actual
   * tarball bytes (the install pipeline at
   * `packages/catalog/src/install/npm-package.ts` will re-verify the
   * same way), entry by reading the package's `bin` / `main` field.
   *
   * Accepts dist-tag names (`latest`, `next`, etc.) in addition to
   * pinned semver — registry entries occasionally record `"latest"`
   * even though the spec forbids it.
   */
  async resolve(name: string, version: string): Promise<NpmResolution> {
    const packument = await this.fetchPackument(name);
    const resolvedVersion = resolveVersion(packument, version);
    if (!resolvedVersion) {
      throw new Error(`npm: ${name}@${version} could not be resolved (no matching version or tag)`);
    }
    const cacheKey = `${name}@${resolvedVersion}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const versionInfo = packument.versions?.[resolvedVersion];
    if (!versionInfo) {
      throw new Error(`npm: ${name}@${resolvedVersion} not found in packument`);
    }
    const tarballUrl = versionInfo.dist?.tarball;
    if (!tarballUrl) {
      throw new Error(`npm: ${name}@${resolvedVersion} has no dist.tarball`);
    }

    const sha256 = await this.hashTarball(tarballUrl);
    const entry = pickEntry(versionInfo);
    if (!entry) {
      throw new Error(`npm: ${name}@${resolvedVersion} has no usable bin/main entry`);
    }

    const result: NpmResolution = {
      facts: { sha256, entry, resolvedVersion },
      licenseSpdx: extractLicense(versionInfo.license),
      warnings: [],
    };
    await this.writeCache(cacheKey, result);
    return result;
  }

  private async fetchPackument(name: string): Promise<NpmPackument> {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`;
    const res = await fetchWithRetry(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, url, body.slice(0, 200));
    }
    return (await res.json()) as NpmPackument;
  }

  private async hashTarball(tarballUrl: string): Promise<string> {
    const res = await fetchWithRetry(tarballUrl);
    if (!res.ok) {
      throw new Error(`npm: tarball fetch ${tarballUrl} failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return createHash('sha256').update(buf).digest('hex');
  }

  private cachePath(key: string): string | null {
    if (!this.opts.cacheDir) return null;
    const safe = key.replace(/[^a-zA-Z0-9._@\-]/g, '_');
    return join(this.opts.cacheDir, `${safe}.json`);
  }

  private async readCache(key: string): Promise<NpmResolution | null> {
    const path = this.cachePath(key);
    if (!path) return null;
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as NpmResolution;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: NpmResolution): Promise<void> {
    const path = this.cachePath(key);
    if (!path) return;
    await ensureDir(path);
    // Trailing newline + LF — see the matching note in
    // `license-resolver.ts`.
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

/**
 * Pick the best entry path for `command: 'node', args: [<entry>]`.
 *
 * Priority:
 *   1. `bin` (string) — exactly what `npx <pkg>` runs.
 *   2. `bin` (object) — first value, alphabetically first key for stability.
 *   3. `main` — node's default require entry. Many CLI MCPs ship as
 *      modules where the bin is a separate small file; `main` works
 *      for the runtime case but may invoke library code without a
 *      shebang. Acceptable fallback.
 *   4. `module` — same idea, ESM variant.
 */
export function pickEntry(v: NpmPackumentVersion): string | null {
  if (typeof v.bin === 'string' && v.bin.trim()) return cleanRel(v.bin);
  if (v.bin && typeof v.bin === 'object') {
    const keys = Object.keys(v.bin).sort();
    for (const k of keys) {
      const val = v.bin[k];
      if (typeof val === 'string' && val.trim()) return cleanRel(val);
    }
  }
  if (v.main?.trim()) return cleanRel(v.main);
  if (v.module?.trim()) return cleanRel(v.module);
  return null;
}

function cleanRel(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Map a registry-supplied version string to a concrete version
 * present in the packument. If the input is already a packument key,
 * use it directly. Otherwise treat it as a dist-tag (`latest`,
 * `next`, etc.) and resolve via `dist-tags`.
 */
export function resolveVersion(packument: NpmPackument, version: string): string | null {
  if (packument.versions?.[version]) return version;
  const tagged = packument['dist-tags']?.[version];
  if (tagged && packument.versions?.[tagged]) return tagged;
  return null;
}

export function extractLicense(license: NpmPackumentVersion['license']): string | null {
  if (typeof license === 'string') return license.trim() || null;
  if (license && typeof license === 'object' && license.type) return license.type.trim() || null;
  return null;
}
