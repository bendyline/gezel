import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  deployedGildeCommunityDir,
  packDeployedGildeCommunity,
  probePackedGildeCommunity,
} from './pack-gilde-community.mjs';

// The workspace build of the loader stands in for the one `pnpm deploy`
// copies into a bundle; the release build packs with the deployed copy.
const catalog = await import(new URL('../packages/catalog/dist/index.js', import.meta.url).href);

const TOOL_IDS = ['acme-widget', 'acme-gadget', 'zeta-thing'];

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** A deployed-bundle-shaped tree with a small gilde community tier. */
async function seedDeployedTree(root) {
  const community = deployedGildeCommunityDir(root);
  await put(join(community, '.gitkeep'), '');
  const entries = [];
  for (const id of TOOL_IDS) {
    const identity = {
      schemaVersion: 1,
      kind: 'toolset',
      id,
      name: id,
      description: `${id} fixture`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    };
    const version = {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      runtime: { kind: 'http-mcp', url: `https://example.com/${id}` },
      tools: [],
      config: [],
    };
    const itemDir = join(community, 'toolsets', id.slice(0, 2), id);
    await put(join(itemDir, 'manifest.json'), identity);
    await put(join(itemDir, 'versions', '1.0.0', 'manifest.json'), version);
    entries.push({ manifest: { ...identity, ...version, availableVersions: ['1.0.0'] } });
  }
  await put(join(community, 'toolsets', 'index.json'), {
    schemaVersion: 1,
    kind: 'toolset',
    count: entries.length,
    entries,
  });
  return community;
}

describe('gilde community packing for bundles', () => {
  let root;
  const priorOverride = process.env.GEZEL_GILDE_DATA_DIR;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-pack-community-'));
  });

  afterEach(async () => {
    if (priorOverride === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
    else process.env.GEZEL_GILDE_DATA_DIR = priorOverride;
    await rm(root, { recursive: true, force: true });
  });

  it('collapses the tier into one pack the loader reads', async () => {
    const community = await seedDeployedTree(root);
    const result = await packDeployedGildeCommunity(root, { label: 'test', catalog });
    assert.equal(result.files, 1 + 1 + TOOL_IDS.length * 2);
    assert.deepEqual(await readdir(community), [catalog.CONTENT_PACK_FILENAME]);

    process.env.GEZEL_GILDE_DATA_DIR = dirname(community);
    assert.deepEqual(await probePackedGildeCommunity(catalog, root), {
      listed: TOOL_IDS.length,
    });
    const detail = await new catalog.CommunitySource().get('toolset', 'zeta-thing');
    assert.equal(detail?.manifest.version, '1.0.0');
  });

  it('refuses a tree without a community tier', async () => {
    await assert.rejects(
      packDeployedGildeCommunity(root, { label: 'test', catalog }),
      /expected the gilde community tier/,
    );
  });

  it('refuses to report success for a tier that was never packed', async () => {
    const community = await seedDeployedTree(root);
    process.env.GEZEL_GILDE_DATA_DIR = dirname(community);
    await assert.rejects(probePackedGildeCommunity(catalog, root), /should hold only/);
  });

  // macOS hands out tmp roots as /var/... while node resolution reports
  // /private/var/...; the containment check must compare realpaths.
  it('accepts a bundle root reached through a symlink', async () => {
    const community = await seedDeployedTree(root);
    await packDeployedGildeCommunity(root, { label: 'test', catalog });
    const linkParent = await mkdtemp(join(tmpdir(), 'gezel-pack-link-'));
    try {
      const linked = join(linkParent, 'root');
      await symlink(root, linked, 'dir');
      process.env.GEZEL_GILDE_DATA_DIR = dirname(await realpath(community));
      assert.deepEqual(await probePackedGildeCommunity(catalog, linked), {
        listed: TOOL_IDS.length,
      });
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it('refuses a probe whose gilde resolves outside the bundle', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'gezel-pack-elsewhere-'));
    try {
      process.env.GEZEL_GILDE_DATA_DIR = join(elsewhere, 'data');
      await assert.rejects(probePackedGildeCommunity(catalog, root), /resolved outside/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('release bundle wiring', () => {
  it('packs and verifies the community tier in both deployed runtimes', async () => {
    const [serviceBuilder, nodeBuilder] = await Promise.all([
      readFile(new URL('./build-service-bundle.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./build-node-bundle.mjs', import.meta.url), 'utf8'),
    ]);
    for (const [name, source] of [
      ['service bundle', serviceBuilder],
      ['node bundle', nodeBuilder],
    ]) {
      assert.match(source, /await packDeployedGildeCommunity\(target, \{ label: '/, name);
      assert.match(source, /await verifyPackedGildeCommunity\(/, name);
    }
  });
});
