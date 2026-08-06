import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as tar from 'tar';

import { inventoryBundleTree, verifyBundleArchiveRoundTrip } from './verify-bundle-archive.mjs';

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
    await tar.create({ gzip: true, file: archivePath, cwd: archiveSourceDir }, ['.']);
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
      /missing 1: node_modules\/entities\/dist\/esm\/decode\.js/,
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
