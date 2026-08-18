import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as tar from 'tar';

import {
  createBundleArchive,
  inventoryBundleArchiveEntries,
  inventoryBundleArchivePaths,
  inventoryBundleTree,
  verifyBundleArchiveRoundTrip,
} from './verify-bundle-archive.mjs';

describe('verifyBundleArchiveRoundTrip', () => {
  let root;
  let sourceDir;
  let archiveSourceDir;
  let archivePath;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-archive-test-'));
    sourceDir = join(root, 'source');
    archiveSourceDir = join(root, 'archive-source');
    archivePath = join(root, 'service-bundle.tar.gz');
    for (const dir of [sourceDir, archiveSourceDir]) {
      await mkdir(join(dir, 'dist', 'bin'), { recursive: true });
      await mkdir(join(dir, 'node_modules', 'entities', 'dist', 'esm'), { recursive: true });
      await writeFile(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
      await writeFile(join(dir, 'dist', 'bin', 'gezeld.js'), 'export {};\n');
      await writeFile(
        join(dir, 'node_modules', 'entities', 'dist', 'esm', 'decode.js'),
        'export const decode = () => {};\n',
      );
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function archive() {
    await createBundleArchive({
      sourceDir: archiveSourceDir,
      archivePath,
    });
  }

  it('validates the extracted tree and exposes it to the runtime check', async () => {
    await archive();
    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    let validated = false;
    const result = await verifyBundleArchiveRoundTrip({
      sourceDir,
      archivePath,
      expectedFileCount,
      validateExtracted: async (extractedDir) => {
        const entries = await inventoryBundleTree(extractedDir);
        assert.ok(entries.some((entry) => entry.path.endsWith('entities/dist/esm/decode.js')));
        validated = true;
      },
    });
    assert.equal(result.fileCount, 3);
    assert.equal(validated, true);
  });

  it('reports a dependency file omitted from the archive', async () => {
    await rm(join(archiveSourceDir, 'node_modules', 'entities', 'dist', 'esm', 'decode.js'));
    await archive();
    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    await assert.rejects(
      verifyBundleArchiveRoundTrip({ sourceDir, archivePath, expectedFileCount }),
      /archive inventory differs from source .* missing 1: node_modules\/entities\/dist\/esm\/decode\.js/,
    );
  });

  it('reports same-size content changed in the archive', async () => {
    await writeFile(join(archiveSourceDir, 'package.json'), '{"version":"9.9.9"}\n');
    await archive();
    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    await assert.rejects(
      verifyBundleArchiveRoundTrip({ sourceDir, archivePath, expectedFileCount }),
      /extracted tree differs from source .* changed 1: package\.json/,
    );
  });

  it('archives every entry in a deep directory with many siblings', async () => {
    const relativeDir = join(
      'node_modules',
      '@bendyline',
      'gilde',
      'data',
      'community',
      'toolsets',
      'br',
      'brilliantdirectories-brilliant-directories-mcp',
      'versions',
    );
    const versions = Array.from({ length: 320 }, (_, index) => `6.40.${index}`);

    for (const dir of [sourceDir, archiveSourceDir]) {
      const versionsDir = join(dir, relativeDir);
      await mkdir(versionsDir, { recursive: true });
      await Promise.all(
        versions.map(async (version) => {
          const versionDir = join(versionsDir, version);
          await mkdir(versionDir);
          await writeFile(join(versionDir, 'manifest.json'), `${version}\n`);
        }),
      );
    }

    await archive();

    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    const archivedPaths = await inventoryBundleArchivePaths(archivePath);
    assert.equal(archivedPaths.length, expectedFileCount);
    assert.ok(
      archivedPaths.includes(
        'node_modules/@bendyline/gilde/data/community/toolsets/br/brilliantdirectories-brilliant-directories-mcp/versions/6.40.26/manifest.json',
      ),
    );
    await verifyBundleArchiveRoundTrip({
      sourceDir,
      archivePath,
      expectedFileCount,
    });
  });

  it('archives hardlinked source files as independent files without stalling', async () => {
    const relativeDir = join('node_modules', 'hardlinked-package');

    for (const dir of [sourceDir, archiveSourceDir]) {
      const hardlinkRoot = join(dir, relativeDir);
      for (let index = 0; index < 20; index += 1) {
        const siblingDir = join(hardlinkRoot, `dir${String(index).padStart(3, '0')}`);
        await mkdir(siblingDir, { recursive: true });
        await writeFile(join(siblingDir, 'plain.txt'), `content-${index}\n`);
      }

      const linkSource = join(hardlinkRoot, 'dir000', 'hardlink-source.txt');
      await writeFile(linkSource, 'shared inode\n');
      for (let index = 1; index < 15; index += 1) {
        await link(
          linkSource,
          join(hardlinkRoot, `dir${String(index).padStart(3, '0')}`, 'hardlink.txt'),
        );
      }
    }

    await archive();

    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    const archivedEntries = await inventoryBundleArchiveEntries(archivePath);
    const archivedPaths = archivedEntries.map((entry) => entry.path);
    assert.equal(archivedPaths.length, expectedFileCount);
    assert.ok(archivedPaths.includes('node_modules/hardlinked-package/dir014/hardlink.txt'));
    assert.equal(archivedEntries.filter((entry) => entry.type === 'Link').length, 0);
    await verifyBundleArchiveRoundTrip({
      sourceDir,
      archivePath,
      expectedFileCount,
    });
  });

  it('rejects archives that encode hardlink entries', async () => {
    const source = join(archiveSourceDir, 'dist', 'bin', 'gezeld.js');
    await link(source, join(archiveSourceDir, 'dist', 'bin', 'gezeld-link.js'));
    await link(
      join(sourceDir, 'dist', 'bin', 'gezeld.js'),
      join(sourceDir, 'dist', 'bin', 'gezeld-link.js'),
    );
    tar.create(
      {
        cwd: archiveSourceDir,
        file: archivePath,
        gzip: true,
        strict: true,
        sync: true,
      },
      ['.'],
    );

    const entries = await inventoryBundleArchiveEntries(archivePath);
    assert.equal(entries.filter((entry) => entry.type === 'Link').length, 1);
    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    await assert.rejects(
      verifyBundleArchiveRoundTrip({ sourceDir, archivePath, expectedFileCount }),
      /archive contains 1 hardlink entries/,
    );
  });

  it('reports metadata files injected into the archive', async () => {
    await writeFile(join(archiveSourceDir, '._package.json'), 'appledouble');
    await archive();
    const expectedFileCount = (await inventoryBundleTree(sourceDir)).length;
    await assert.rejects(
      verifyBundleArchiveRoundTrip({ sourceDir, archivePath, expectedFileCount }),
      /unexpected 1: \._package\.json/,
    );
  });

  it('rejects stale metadata even when the archive mirrors the source', async () => {
    await archive();
    await assert.rejects(
      verifyBundleArchiveRoundTrip({ sourceDir, archivePath, expectedFileCount: 99 }),
      /source file count 3 does not match metadata 99/,
    );
  });
});
