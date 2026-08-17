import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSharedServiceTree } from './shared-service-tree.js';

const SHIPPED_SHA = createHash('sha256').update('shipped bundle').digest('hex');
const OTHER_SHA = createHash('sha256').update('some other bundle').digest('hex');

/** Mode checks are the whole basis for trusting the tree, and Windows has none. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('resolveSharedServiceTree', () => {
  let root: string;
  let serviceHome: string;
  let treeDir: string;
  let metaPath: string;

  async function seedMeta(sha = SHIPPED_SHA): Promise<void> {
    await writeFile(
      metaPath,
      JSON.stringify({ version: '1.2.3', sha256: sha, sizeBytes: 10, fileCount: 2 }),
    );
  }

  async function seedTree(sha: string | null): Promise<void> {
    await mkdir(join(treeDir, 'dist', 'bin'), { recursive: true });
    await writeFile(join(treeDir, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n');
    if (sha) await writeFile(join(treeDir, '.gezel-bundle.sha256'), `${sha}\n`);
    // What the installer hooks leave behind: readable, not writable by anyone
    // but the service account.
    await chmod(serviceHome, 0o711);
    await chmod(treeDir, 0o755);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-shared-tree-'));
    serviceHome = join(root, 'system-home');
    treeDir = join(serviceHome, 'service');
    metaPath = join(root, 'service-bundle.meta.json');
    await mkdir(serviceHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('adopts an installer-owned tree carrying the shipped bundle sha', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBe(
      treeDir,
    );
  });

  posixOnly('declines a tree built from a different bundle', async () => {
    // The app-only-update case: electron-updater replaced the shell but cannot
    // rewrite the root-owned tree, so the machine copy is a release behind.
    // Adopting it would silently run last release's daemon code.
    await seedMeta();
    await seedTree(OTHER_SHA);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines a tree with no sentinel at all', async () => {
    await seedMeta();
    await seedTree(null);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines when the daemon entry point is missing', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await rm(join(treeDir, 'dist', 'bin', 'gezeld.js'));

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines a world-writable tree even when the sha matches', async () => {
    // A tree this account could rewrite carries no more trust than a local
    // extraction, and the sentinel proves nothing when whoever planted the
    // bytes could plant the sentinel too.
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await chmod(treeDir, 0o777);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines when the tree parent is world-writable', async () => {
    // Write access to the parent is rename access to the tree.
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await chmod(serviceHome, 0o777);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines when there is no machine service home', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);

    expect(
      await resolveSharedServiceTree({ metaPath, serviceHome: null, platform: 'linux' }),
    ).toBeNull();
  });

  posixOnly('declines when the shipped meta is unreadable', async () => {
    await seedTree(SHIPPED_SHA);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  it('never adopts on Windows, where the mode check is vacuous', async () => {
    await seedMeta();
    await mkdir(join(treeDir, 'dist', 'bin'), { recursive: true });
    await writeFile(join(treeDir, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n');
    await writeFile(join(treeDir, '.gezel-bundle.sha256'), `${SHIPPED_SHA}\n`);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'win32' })).toBeNull();
  });
});
