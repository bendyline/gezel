/**
 * The published manifest and payload of every npm package.
 *
 * `npm pack --dry-run` is the authority on what actually ships: it applies
 * the `files` field, the implicit includes (README, LICENSE, package.json)
 * and the implicit excludes. Asserting against `dist/` on disk would miss
 * both.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  VERSIONED_NOT_PUBLISHED,
  exportTargets,
  loadPublishedPackages,
  readManifest,
} from './_packages';

interface PackFile {
  path: string;
  size: number;
}
interface PackResult {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackFile[];
}

/**
 * Coarse release guardrails, not byte-level regression targets. Keep enough
 * headroom that ordinary feature work does not require ratcheting these,
 * while still catching an accidental payload addition — the case that
 * motivated them was `dist/ui` plus source maps putting the service at
 * 39.4 MB packed / 138.5 MB unpacked before `!dist/**\/*.map` was added.
 */
const PACKED_SIZE_BUDGETS: Record<string, number> = {
  // Roughly 1.5x the measured size at the time of writing, so ordinary
  // feature work has room without a ratchet.        measured (packed)
  '@bendyline/gezel': 1_100_000, //                    734 KB
  '@bendyline/gezel-client': 250_000, //                94 KB
  '@bendyline/gezel-sdk': 150_000, //                   47 KB
  '@bendyline/gezel-app-sdk': 100_000, //               12 KB
  '@bendyline/gezel-plugin-sdk': 50_000, //              2 KB
  '@bendyline/gezel-catalog': 150_000, //               28 KB
  '@bendyline/gezel-mcp': 300_000, //                  111 KB
  '@bendyline/gezel-connectors-spectral': 100_000, //    4 KB
  '@bendyline/gezel-script-stdlib': 100_000, //         14 KB
  '@bendyline/gezel-cli': 150_000, //                   31 KB
  // Carries the bundled web UI (`dist/ui`) and the handboek content so a
  // Node-only CLI install can serve `gezel start --web` with nothing else
  // to fetch. That is essentially all of this budget.
  '@bendyline/gezel-service': 25_000_000, //          18.1 MB
};

const caches: string[] = [];
afterAll(() => {
  for (const dir of caches) rmSync(dir, { recursive: true, force: true });
});

function dryRunPack(directory: string): PackResult {
  const cache = mkdtempSync(join(tmpdir(), 'gezel-pack-cache-'));
  caches.push(cache);
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'pack',
      '.',
      '--dry-run',
      '--json',
      '--ignore-scripts',
      '--workspaces=false',
      '--cache',
      cache,
    ],
    { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`npm pack failed in ${directory}:\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packed?.files) throw new Error(`npm pack returned no package for ${directory}`);
  return packed as PackResult;
}

const packages = loadPublishedPackages();

describe('published package manifests', () => {
  it.each(packages)('$name is publishable', ({ pkg }) => {
    expect(pkg.private, 'must not be private — nothing would publish').toBeUndefined();
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.publishConfig?.provenance).toBe(true);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(packages)('$name carries npm page metadata', ({ dir, pkg }) => {
    const manifest = pkg as unknown as Record<string, unknown>;
    expect(manifest.description, 'shown under the package name on npm').toBeTruthy();
    expect(manifest.license).toBe('MIT');
    expect(manifest.homepage).toBeTruthy();
    expect(manifest.repository).toMatchObject({ directory: `packages/${dir}` });
  });

  it.each(VERSIONED_NOT_PUBLISHED)('%s stays private so publish-package.mjs skips it', (dir) => {
    // multi-semantic-release versions, tags and changelogs these, but they
    // ship through electron-builder / the VS Code Marketplace. `private`
    // is the only switch keeping them off npm.
    expect(readManifest(dir).private).toBe(true);
  });
});

describe('published package payloads', () => {
  const packed = new Map(packages.map((p) => [p.name, dryRunPack(p.path)] as const));

  it.each(packages)('$name ships no source maps', ({ name }) => {
    const maps = packed.get(name)!.files.filter((f) => f.path.endsWith('.map'));
    expect(maps.map((f) => f.path)).toEqual([]);
  });

  it.each(packages)('$name stays inside its packed-size budget', ({ name }) => {
    const budget = PACKED_SIZE_BUDGETS[name];
    expect(budget, `no size budget declared for ${name}`).toBeDefined();
    expect(packed.get(name)!.size).toBeLessThanOrEqual(budget);
  });

  it.each(packages)('$name ships a README for its npm page', ({ name }) => {
    const files = packed.get(name)!.files.map((f) => f.path.toLowerCase());
    expect(files).toContain('readme.md');
  });

  it.each(packages)(
    '$name ships every file its exports and bin point at',
    ({ name, path, pkg }) => {
      const shipped = new Set(packed.get(name)!.files.map((f) => f.path.replace(/\\/g, '/')));
      const referenced = [
        ...exportTargets(pkg).map((t) => t.target),
        ...Object.values(pkg.bin ?? {}),
        pkg.main,
        pkg.module,
        pkg.types,
      ].filter((t): t is string => typeof t === 'string' && t.startsWith('./'));

      for (const target of new Set(referenced)) {
        const relative = target.slice(2);
        // Wildcard subpaths (`./scripts/*`) resolve at import time; assert the
        // directory exists rather than trying to expand the pattern here.
        if (relative.includes('*')) {
          expect(existsSync(resolve(path, relative.split('*')[0]))).toBe(true);
          continue;
        }
        expect(
          shipped.has(relative) || relative === 'package.json',
          `${name}: ${target} is referenced but not packed`,
        ).toBe(true);
      }
    },
  );

  it('reports the packed footprint', () => {
    const rows = packages
      .map((p) => ({ name: p.name, ...packed.get(p.name)! }))
      .sort((a, b) => b.size - a.size)
      .map(
        (r) =>
          `  ${(r.size / 1e6).toFixed(2)} MB  ${r.entryCount.toString().padStart(4)} files  ${r.name}`,
      );
    console.log(`packed footprint (repo root ${REPO_ROOT}):\n${rows.join('\n')}`);
    expect(rows.length).toBe(packages.length);
  });
});
