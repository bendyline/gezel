import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duckdbBinaryName, duckdbInstallDir } from '@bendyline/gezel/native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDuckdbIfNeeded } from './extract-duckdb.js';

let home: string;
let bundleDir: string;
const binaryName = duckdbBinaryName(process.platform);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stage a bundle in the shape fetch-duckdb.mjs emits. */
async function stageBundle(contents: string, version = '1.5.5', manifest = true) {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, binaryName), contents);
  await writeFile(join(bundleDir, 'version.txt'), `${version}\n`);
  await writeFile(join(bundleDir, 'LICENSE.txt'), 'MIT');
  if (manifest) {
    await writeFile(join(bundleDir, 'sha256.txt'), `${sha(contents)}  ${binaryName}\n`);
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-duckdb-home-'));
  bundleDir = await mkdtemp(join(tmpdir(), 'gezel-duckdb-bundle-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(bundleDir, { recursive: true, force: true });
});

describe('installDuckdbIfNeeded', () => {
  it('installs into the version-keyed directory the engine resolver also uses', async () => {
    await stageBundle('duckdb-bytes');
    const result = await installDuckdbIfNeeded({ home, bundleDir });

    // Same directory as the CLI downloader on purpose: one machine, one
    // verified copy, whichever installer got there first.
    expect(result.binaryPath).toBe(join(duckdbInstallDir(home, '1.5.5'), binaryName));
    expect(result.action).toBe('fresh-install');
    expect(result.verified).toBe(true);
    expect(await readFile(result.binaryPath as string, 'utf8')).toBe('duckdb-bytes');
  });

  it('writes a sentinel the engine resolver can read, so the CLI does not re-download', async () => {
    await stageBundle('duckdb-bytes');
    await installDuckdbIfNeeded({ home, bundleDir });

    const sentinel = JSON.parse(
      await readFile(join(duckdbInstallDir(home, '1.5.5'), '.verified.json'), 'utf8'),
    );
    expect(sentinel).toMatchObject({
      engine: 'duckdb',
      version: '1.5.5',
      binarySha: sha('duckdb-bytes'),
      source: 'electron-bundle',
    });
    // The archive digest is what the resolver's warm-cache check compares.
    expect(typeof sentinel.archiveSha).toBe('string');
  });

  it('omits the archive digest when the bundle version is not this build’s pin', async () => {
    // Guessing it would make the CLI trust a warm cache it never verified.
    await stageBundle('other-bytes', '9.9.9');
    await installDuckdbIfNeeded({ home, bundleDir });
    const sentinel = JSON.parse(
      await readFile(join(duckdbInstallDir(home, '9.9.9'), '.verified.json'), 'utf8'),
    );
    expect(sentinel.archiveSha).toBeUndefined();
  });

  it('is idempotent on a second run', async () => {
    await stageBundle('duckdb-bytes');
    await installDuckdbIfNeeded({ home, bundleDir });
    const second = await installDuckdbIfNeeded({ home, bundleDir });
    expect(second.action).toBe('up-to-date');
  });

  it('refreshes an installed binary whose bytes drifted from the bundle', async () => {
    await stageBundle('duckdb-bytes');
    const first = await installDuckdbIfNeeded({ home, bundleDir });
    await writeFile(first.binaryPath as string, 'tampered');

    const second = await installDuckdbIfNeeded({ home, bundleDir });
    expect(second.action).toBe('refreshed');
    expect(await readFile(second.binaryPath as string, 'utf8')).toBe('duckdb-bytes');
  });

  it('refuses to install when the bundle fails its own integrity manifest', async () => {
    await stageBundle('duckdb-bytes');
    await writeFile(join(bundleDir, 'sha256.txt'), `${'0'.repeat(64)}  ${binaryName}\n`);

    const result = await installDuckdbIfNeeded({ home, bundleDir });
    expect(result.action).toBe('no-bundle');
    expect(result.binaryPath).toBeNull();
    expect(existsSync(join(duckdbInstallDir(home, '1.5.5'), binaryName))).toBe(false);
  });

  it('reports no-bundle rather than throwing when nothing shipped', async () => {
    // Dev builds and GEZEL_DUCKDB_SKIP=1 ship no bundle; the daemon must still
    // boot and simply report the query engine as unavailable.
    const result = await installDuckdbIfNeeded({ home, bundleDir: join(bundleDir, 'absent') });
    expect(result).toMatchObject({ action: 'no-bundle', binaryPath: null, verified: false });
  });
});
