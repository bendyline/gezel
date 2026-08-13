import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  extractBundleIfNeeded,
  readBundleMeta,
  redirectAsarToUnpacked,
} from './extract-bundle.js';

/**
 * Above every platform's pid ceiling (Linux caps at 2^22 even with
 * `pid_max` raised), so `process.kill(DEAD_PID, 0)` reliably reports
 * ESRCH — the sweep's "owner is gone" branch — without the flakiness of
 * reusing a pid the OS could hand to something else mid-test.
 */
const DEAD_PID = 2147483646;

/**
 * Taken from a staging tree found abandoned on a real install (a launch
 * killed ~75% through extraction, 683 MB stranded for twelve days). Using
 * the field-observed uuid rather than a synthetic one keeps the name shape
 * these tests assert against pinned to what production actually writes.
 */
const STAGING_UUID = 'b2ca0a0c-00b9-4a03-b054-25a0d7d73ebd';

interface SeedOptions {
  version: string;
  /** Override the sha256 baked into the meta. Defaults to a stable per-version sha. */
  sha256?: string;
  extraFile?: { path: string; content: string };
}

function fakeSha(seed: string): string {
  // 64-char hex deterministic from seed — keeps tests readable without
  // requiring real sha computation. Non-hex chars in the seed get
  // replaced so the result passes the sentinel's `[0-9a-f]{64}` check.
  const hex = seed.replace(/[^0-9a-f]/gi, '0').toLowerCase();
  return hex.padEnd(64, '0').slice(0, 64);
}

/**
 * Build a fake service tarball + meta sidecar at the given paths. The
 * tarball has the same shape as the real one: top-level package.json,
 * dist/bin/gezeld.js, plus an optional extra file for staleness checks.
 */
async function seedTarballBundle(
  workDir: string,
  tarballPath: string,
  metaPath: string,
  opts: SeedOptions,
): Promise<string> {
  const staging = join(workDir, 'staging');
  await mkdir(join(staging, 'dist', 'bin'), { recursive: true });
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify({ name: '@bendyline/gezel-service', version: opts.version }, null, 2),
  );
  await writeFile(join(staging, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n');
  if (opts.extraFile) {
    await mkdir(join(staging, opts.extraFile.path, '..'), { recursive: true });
    await writeFile(join(staging, opts.extraFile.path), opts.extraFile.content);
  }
  await tar.create({ gzip: true, file: tarballPath, cwd: staging }, ['.']);
  // Compute the REAL tarball sha for the meta: extractBundleIfNeeded now
  // verifies the tarball bytes against meta.sha256 before extracting, so a
  // fixture's meta must match its tarball — exactly as production's
  // build:bundle writes the sha it computed over the bytes it produced.
  const sha256 =
    opts.sha256 ??
    createHash('sha256')
      .update(await readFile(tarballPath))
      .digest('hex');
  const sizeBytes = (await stat(tarballPath)).size;
  await writeFile(
    metaPath,
    JSON.stringify(
      { version: opts.version, sha256, sizeBytes, fileCount: 2 + (opts.extraFile ? 1 : 0) },
      null,
      2,
    ),
  );
  await rm(staging, { recursive: true, force: true });
  return sha256;
}

/**
 * Seed an "installed" tree at `installDir` — used to simulate a prior
 * install when testing the upgrade / downgrade / up-to-date branches.
 * Pass `sha` to also seed the `.gezel-bundle.sha256` sentinel; omit it
 * to simulate an older install that predates the sentinel.
 */
async function seedInstalledTree(
  dir: string,
  version: string,
  extraFile?: { path: string; content: string },
  sha?: string,
): Promise<void> {
  await mkdir(join(dir, 'dist', 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@bendyline/gezel-service', version }, null, 2),
  );
  await writeFile(join(dir, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n');
  if (extraFile) {
    await mkdir(join(dir, extraFile.path, '..'), { recursive: true });
    await writeFile(join(dir, extraFile.path), extraFile.content);
  }
  if (sha) {
    await writeFile(join(dir, '.gezel-bundle.sha256'), `${sha}\n`);
  }
}

describe('compareVersions', () => {
  it('handles equality', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('handles simple ordering', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.3.0', '1.2.99')).toBeGreaterThan(0);
  });
  it('treats missing parts as 0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('redirectAsarToUnpacked', () => {
  it('rewrites Windows app.asar paths to app.asar.unpacked', () => {
    expect(
      redirectAsarToUnpacked(
        'C:\\Program Files\\Gezel\\resources\\app.asar\\dist\\service-bundle.tar.gz',
      ),
    ).toBe('C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\service-bundle.tar.gz');
  });
  it('rewrites POSIX app.asar paths', () => {
    expect(
      redirectAsarToUnpacked('/Applications/Gezel.app/Contents/Resources/app.asar/dist/x.js'),
    ).toBe('/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/dist/x.js');
  });
  it('handles bare app.asar dir paths (no trailing separator)', () => {
    expect(redirectAsarToUnpacked('C:\\foo\\app.asar')).toBe('C:\\foo\\app.asar.unpacked');
    expect(redirectAsarToUnpacked('/foo/app.asar')).toBe('/foo/app.asar.unpacked');
  });
  it('leaves dev paths untouched', () => {
    expect(redirectAsarToUnpacked('C:\\gh\\gezel\\packages\\app\\dist\\service-bundle')).toBe(
      'C:\\gh\\gezel\\packages\\app\\dist\\service-bundle',
    );
    expect(redirectAsarToUnpacked('/repo/packages/app/dist/service-bundle')).toBe(
      '/repo/packages/app/dist/service-bundle',
    );
  });
  it('does not double-rewrite a path that already points at app.asar.unpacked', () => {
    const already = 'C:\\foo\\app.asar.unpacked\\dist\\x';
    expect(redirectAsarToUnpacked(already)).toBe(already);
  });
  it('does not match a substring like "app.asar" inside another segment', () => {
    expect(redirectAsarToUnpacked('C:\\foo\\my-app.asar.dir\\bar')).toBe(
      'C:\\foo\\my-app.asar.dir\\bar',
    );
  });
});

describe('readBundleMeta', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-meta-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when the meta file is missing', async () => {
    expect(await readBundleMeta(join(root, 'missing.json'))).toBeNull();
  });
  it('returns null when the meta file is malformed JSON', async () => {
    const p = join(root, 'meta.json');
    await writeFile(p, '{ not json');
    expect(await readBundleMeta(p)).toBeNull();
  });
  it('returns null when required fields are missing', async () => {
    const p = join(root, 'meta.json');
    await writeFile(p, JSON.stringify({ version: '1.0.0' }));
    expect(await readBundleMeta(p)).toBeNull();
  });
  it('returns the meta when all fields are present and well-typed', async () => {
    const p = join(root, 'meta.json');
    const meta = { version: '1.0.0', sha256: 'abc', sizeBytes: 100, fileCount: 5 };
    await writeFile(p, JSON.stringify(meta));
    expect(await readBundleMeta(p)).toEqual(meta);
  });
});

describe('extractBundleIfNeeded', () => {
  let root: string;
  let tarballPath: string;
  let metaPath: string;
  let installDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-bundle-'));
    tarballPath = join(root, 'service-bundle.tar.gz');
    metaPath = join(root, 'service-bundle.meta.json');
    installDir = join(root, 'install');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('performs a fresh install when the install dir is absent', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('fresh-install');
    expect(res.installedVersion).toBe('0.1.0');
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.1.0');
    // Sentinel should be written so subsequent calls hit the up-to-date fast path.
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('upgrades when shipped > installed', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.2.0' });
    await seedInstalledTree(
      installDir,
      '0.1.0',
      { path: 'stale.txt', content: 'old' },
      fakeSha('0.1.0'),
    );
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('upgraded');
    expect(res.installedVersion).toBe('0.2.0');
    // Stale artifact from the old install should be wiped after upgrade.
    await expect(readFile(join(installDir, 'stale.txt'), 'utf8')).rejects.toThrow();
    // New sentinel should reflect the new sha.
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('keeps a newer installed version (never downgrades)', async () => {
    await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.2.0', undefined, fakeSha('0.2.0'));
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('kept-newer');
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.2.0');
  });

  it('reports up-to-date when sha matches', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0', undefined, sha);
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('up-to-date');
  });

  it('re-extracts when sha differs but versions match (content drift)', async () => {
    // The case the user hit during pre-1.0 development: every build is
    // v0.0.0 but tarball content changes after each rebuild.
    // Drift lives on the INSTALL side: shipped meta sha always matches its
    // tarball, but the installed sentinel is stale from a prior build.
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.0.0' });
    await seedInstalledTree(
      installDir,
      '0.0.0',
      { path: 'stale.txt', content: 'old broken tree' },
      'bb'.repeat(32),
    );
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('upgraded');
    // Stale file from the old broken install should be gone.
    await expect(readFile(join(installDir, 'stale.txt'), 'utf8')).rejects.toThrow();
    // Sentinel should reflect the new sha.
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('re-extracts when sentinel is missing (older install layout)', async () => {
    // Pre-sentinel installs (or hand-extracted trees) have package.json
    // but no .gezel-bundle.sha256. Treat as content unknown — re-extract.
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(
      installDir,
      '0.1.0',
      undefined /* no extraFile */,
      undefined /* no sha */,
    );
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('upgraded');
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('treats malformed sentinel content as missing', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0');
    // Garbage in the sentinel — not 64 hex chars — should be ignored so
    // we don't get stuck in an "up-to-date" loop with a corrupt file.
    await writeFile(join(installDir, '.gezel-bundle.sha256'), 'not-a-hash');
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });
    expect(res.action).toBe('upgraded');
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('force-extracts regardless of version or sha', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(
      installDir,
      '0.2.0',
      { path: 'stale.txt', content: 'old' },
      fakeSha('0.2.0'),
    );
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir, force: true });
    expect(res.action).toBe('forced');
    // The forced extract overwrites the newer install with the shipped 0.1.0.
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.1.0');
    await expect(readFile(join(installDir, 'stale.txt'), 'utf8')).rejects.toThrow();
    // Sentinel updated.
    const sentinel = await readFile(join(installDir, '.gezel-bundle.sha256'), 'utf8');
    expect(sentinel.trim()).toBe(sha);
  });

  it('keeps the live install untouched when staged validation fails', async () => {
    await seedTarballBundle(root, tarballPath, metaPath, { version: '0.2.0' });
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { version: string };
    meta.version = '0.3.0';
    await writeFile(metaPath, JSON.stringify(meta));
    await seedInstalledTree(installDir, '0.1.0', { path: 'still-live.txt', content: 'good' });

    await expect(extractBundleIfNeeded({ tarballPath, metaPath, installDir })).rejects.toThrow(
      /does not match/,
    );
    expect(await readFile(join(installDir, 'still-live.txt'), 'utf8')).toBe('good');
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.1.0');
  });

  it('rejects an extracted tree whose file count does not match the bundle metadata', async () => {
    await seedTarballBundle(root, tarballPath, metaPath, { version: '0.2.0' });
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { fileCount: number };
    meta.fileCount += 1;
    await writeFile(metaPath, JSON.stringify(meta));
    await seedInstalledTree(installDir, '0.1.0', { path: 'still-live.txt', content: 'good' });

    await expect(extractBundleIfNeeded({ tarballPath, metaPath, installDir })).rejects.toThrow(
      /post-extract file count mismatch \(extracted=2 expected=3\)/,
    );
    expect(await readFile(join(installDir, 'still-live.txt'), 'utf8')).toBe('good');
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.1.0');
  });

  it('removes a staging tree abandoned by a dead process', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0', undefined, sha);
    const abandoned = `${installDir}.staging-${DEAD_PID}-${STAGING_UUID}`;
    await mkdir(join(abandoned, 'node_modules', 'deep'), { recursive: true });
    await writeFile(join(abandoned, 'node_modules', 'deep', 'partial.js'), 'half a bundle');

    // The up-to-date fast path: nothing is extracted, and the orphan still
    // has to be reclaimed — that is the only case that ever creates one.
    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });

    expect(res.action).toBe('up-to-date');
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(join(installDir, 'package.json'))).toBe(true);
  });

  it('keeps a staging tree whose owning process is still running', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0', undefined, sha);
    // A concurrent extraction must never be deleted out from under itself.
    const live = `${installDir}.staging-${process.pid}-${STAGING_UUID}`;
    await mkdir(live, { recursive: true });

    await extractBundleIfNeeded({ tarballPath, metaPath, installDir });

    expect(existsSync(live)).toBe(true);
  });

  it('only deletes exact staging-tree names among its siblings', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0', undefined, sha);
    // Everything here shares a prefix, a word, or a shape with a staging
    // tree without being one. The install parent is a real user home in
    // production, so a near-miss must be a no-op.
    const bystanders = [
      `${installDir}.previous`,
      `${installDir}.staging`,
      `${installDir}.staging-${DEAD_PID}`,
      `${installDir}.staging-${DEAD_PID}-not-a-uuid`,
      `${installDir}.staging-0-${STAGING_UUID}`,
      `${installDir}.staging-${DEAD_PID}-${STAGING_UUID}.bak`,
      `${installDir}-other.staging-${DEAD_PID}-${STAGING_UUID}`,
      join(root, `staging-${DEAD_PID}-${STAGING_UUID}`),
      join(root, 'gezels'),
    ];
    for (const dir of bystanders) await mkdir(dir, { recursive: true });

    await extractBundleIfNeeded({ tarballPath, metaPath, installDir });

    for (const dir of bystanders) {
      expect(existsSync(dir), `${basename(dir)} must survive the sweep`).toBe(true);
    }
  });

  it('does not delete through a symlink planted where a staging tree would be', async () => {
    const sha = await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await seedInstalledTree(installDir, '0.1.0', undefined, sha);
    const target = join(root, 'precious');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'not ours to delete');
    const planted = `${installDir}.staging-${DEAD_PID}-${STAGING_UUID}`;
    try {
      await symlink(target, planted, 'junction');
    } catch {
      // Unprivileged Windows without Developer Mode cannot create links.
      // The guard is still exercised on every other platform and in CI.
      return;
    }

    await extractBundleIfNeeded({ tarballPath, metaPath, installDir });

    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it('completes the install when an abandoned staging tree cannot be removed', async () => {
    await seedTarballBundle(root, tarballPath, metaPath, { version: '0.2.0' });
    await seedInstalledTree(installDir, '0.1.0');
    // A plain file wearing a staging tree's name: lstat says "not a
    // directory", so it is skipped rather than unlinked, and the upgrade
    // it shares a run with still lands.
    const impostor = `${installDir}.staging-${DEAD_PID}-${STAGING_UUID}`;
    await writeFile(impostor, 'not a directory');

    const res = await extractBundleIfNeeded({ tarballPath, metaPath, installDir });

    expect(res.action).toBe('upgraded');
    expect(existsSync(impostor)).toBe(true);
  });

  it('recovers a previous install left by an interrupted directory swap', async () => {
    await seedInstalledTree(`${installDir}.previous`, '0.1.0');
    await expect(extractBundleIfNeeded({ tarballPath, metaPath, installDir })).rejects.toThrow(
      /Expected service bundle/,
    );
    const installedPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    expect(installedPkg.version).toBe('0.1.0');
  });

  it('throws a clear error when tarball is missing', async () => {
    await expect(extractBundleIfNeeded({ tarballPath, metaPath, installDir })).rejects.toThrow(
      /Expected service bundle at/,
    );
  });

  it('throws a clear error when meta is missing', async () => {
    // Write only the tarball (re-using the seeder by also producing meta,
    // then deleting it).
    await seedTarballBundle(root, tarballPath, metaPath, { version: '0.1.0' });
    await rm(metaPath);
    await expect(extractBundleIfNeeded({ tarballPath, metaPath, installDir })).rejects.toThrow(
      /Expected service bundle meta at/,
    );
  });
});
