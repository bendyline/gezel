import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommunitySource } from './community-source.js';
import { CatalogService } from './service.js';

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const FAKE_SHA = 'a'.repeat(64);

describe('CommunitySource', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-community-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads on-disk toolset entries with the same loader as BundledSource', async () => {
    const itemDir = join(root, 'toolsets', 'ac', 'acme-widget');
    await writeJsonFile(join(itemDir, 'manifest.json'), {
      schemaVersion: 1,
      kind: 'toolset',
      id: 'acme-widget',
      name: 'Acme Widget',
      description: 'A widget MCP.',
      tags: [],
      maintainer: { name: 'acme' },
      license: 'MIT',
      yankedVersions: [],
    });
    await writeJsonFile(join(itemDir, 'versions', '1.0.0', 'manifest.json'), {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-30T00:00:00Z',
      runtime: {
        kind: 'npm-package',
        package: '@acme/widget-mcp',
        version: '1.0.0',
        sha256: FAKE_SHA,
        entry: 'dist/index.js',
        args: [],
        envHints: [],
      },
      tools: [],
      config: [],
    });

    const source = new CommunitySource(root);
    expect(source.id).toBe('community');
    expect(source.label).toBe('MCP Registry (community)');

    const items = await source.list('toolset');
    expect(items).toHaveLength(1);
    expect(items[0]?.manifest.id).toBe('acme-widget');
    expect(items[0]?.sourceId).toBe('community');
  });

  it('is shadowed by BundledSource on id collision when composed in CatalogService', async () => {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'gezel-bundled-'));
    const communityRoot = await mkdtemp(join(tmpdir(), 'gezel-community-'));
    try {
      const seed = async (root: string, label: string) => {
        const itemDir = join(root, 'toolsets', 'sh', 'shared-id');
        await writeJsonFile(join(itemDir, 'manifest.json'), {
          schemaVersion: 1,
          kind: 'toolset',
          id: 'shared-id',
          name: label,
          description: '',
          tags: [],
          maintainer: { name: 'x' },
          license: 'MIT',
          yankedVersions: [],
        });
        await writeJsonFile(join(itemDir, 'versions', '1.0.0', 'manifest.json'), {
          schemaVersion: 1,
          version: '1.0.0',
          releasedAt: '2026-04-30T00:00:00Z',
          runtime: {
            kind: 'npm-package',
            package: '@x/shared',
            version: '1.0.0',
            sha256: FAKE_SHA,
            entry: 'dist/index.js',
            args: [],
            envHints: [],
          },
          tools: [],
          config: [],
        });
      };
      await seed(bundledRoot, 'Bundled wins');
      await seed(communityRoot, 'Community loses');

      const { BundledSource } = await import('./source.js');
      const svc = new CatalogService([
        new BundledSource(bundledRoot),
        new CommunitySource(communityRoot),
      ]);
      const items = await svc.list('toolset');
      expect(items).toHaveLength(1);
      expect(items[0]?.manifest.name).toBe('Bundled wins');
    } finally {
      await rm(bundledRoot, { recursive: true, force: true });
      await rm(communityRoot, { recursive: true, force: true });
    }
  });
});
