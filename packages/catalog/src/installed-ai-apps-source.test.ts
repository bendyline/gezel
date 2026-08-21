import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aiAppItemsDir, aiAppsRegistryFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstalledAiAppsSource } from './installed-ai-apps-source.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeProjectType(
  home: string,
  appId: string,
  appVersion: string,
  item: {
    id: string;
    name: string;
    versions: string[];
    logo?: string;
  },
): Promise<void> {
  const itemDir = join(
    aiAppItemsDir(home, appId, appVersion),
    'project-types',
    item.id.slice(0, 2),
    item.id,
  );
  await writeJson(join(itemDir, 'manifest.json'), {
    schemaVersion: 1,
    kind: 'project-type',
    id: item.id,
    name: item.name,
    description: `${item.name} fixture`,
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
    ...(item.logo ? { logo: item.logo } : {}),
  });
  for (const version of item.versions) {
    const versionDir = join(itemDir, 'versions', version);
    await writeJson(join(versionDir, 'manifest.json'), {
      schemaVersion: 1,
      version,
      releasedAt: '2026-08-20T00:00:00Z',
      aboutTemplate: 'about.md',
    });
    await writeFile(join(versionDir, 'about.md'), `${item.name} ${version}`);
  }
  if (item.logo && !/^https?:\/\//.test(item.logo)) {
    await writeFile(join(itemDir, item.logo), '<svg>installed</svg>');
  }
}

function registryEntry(appId: string, version: string, enabled: boolean) {
  return {
    appId,
    version,
    packageSha256: 'a'.repeat(64),
    installedAt: '2026-08-20T00:00:00.000Z',
    enabled,
  };
}

describe('InstalledAiAppsSource', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-installed-ai-apps-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('mounts enabled app versions and rescopes their items and files', async () => {
    await writeProjectType(home, 'enabled-app', '2.0.0', {
      id: 'alpha-project',
      name: 'Alpha Project',
      versions: ['1.0.0', '1.1.0'],
      logo: 'logo.svg',
    });
    await writeProjectType(home, 'enabled-app', '2.0.0', {
      id: 'zulu-project',
      name: 'Zulu Project',
      versions: ['1.0.0'],
      logo: 'https://example.com/zulu.svg',
    });
    await writeProjectType(home, 'disabled-app', '1.0.0', {
      id: 'hidden-project',
      name: 'Hidden Project',
      versions: ['1.0.0'],
    });
    await writeJson(aiAppsRegistryFile(home), {
      schemaVersion: 1,
      apps: [
        registryEntry('enabled-app', '2.0.0', true),
        registryEntry('disabled-app', '1.0.0', false),
      ],
    });

    const source = new InstalledAiAppsSource(home);
    expect(source.id).toBe('installed-ai-apps');
    expect(source.label).toBe('AI Apps');
    expect(await source.listKinds()).toEqual([
      'project-type',
      'gezel-template',
      'craftbook-template',
    ]);

    const items = await source.list('project-type');
    expect(items.map((item) => item.manifest.id)).toEqual(['alpha-project', 'zulu-project']);
    expect(items[0]).toMatchObject({
      sourceId: 'installed-ai-apps',
      logoUrl: '/api/catalog/project-type/alpha-project/file/logo.svg?source=installed-ai-apps',
    });
    expect(items[1]?.logoUrl).toBe('https://example.com/zulu.svg');

    const detail = await source.get('project-type', 'alpha-project');
    expect(detail).toMatchObject({
      sourceId: 'installed-ai-apps',
      about: 'Alpha Project 1.1.0',
      manifest: { version: '1.1.0' },
    });
    expect(await source.get('project-type', 'hidden-project')).toBeNull();

    const versions = await source.listVersions('project-type', 'alpha-project');
    expect(versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
    await expect(
      source.readItemFile('project-type', 'alpha-project', 'logo.svg', '1.1.0'),
    ).resolves.toEqual(Buffer.from('<svg>installed</svg>'));
    expect(await source.listItemFiles('project-type', 'alpha-project')).toEqual(
      expect.arrayContaining([
        'logo.svg',
        'manifest.json',
        'versions/1.0.0/about.md',
        'versions/1.1.0/manifest.json',
      ]),
    );
  });

  it('degrades an invalid registry to empty and rejects unsupported kinds', async () => {
    await mkdir(dirname(aiAppsRegistryFile(home)), { recursive: true });
    await writeFile(aiAppsRegistryFile(home), '{not valid json', 'utf8');
    const source = new InstalledAiAppsSource(home);

    await expect(source.list('project-type')).resolves.toEqual([]);
    await expect(source.list('chat-model')).resolves.toEqual([]);
    await expect(source.get('chat-model', 'anything')).resolves.toBeNull();
    await expect(source.listVersions('chat-model', 'anything')).resolves.toEqual([]);
    await expect(source.readItemFile('chat-model', 'anything', 'file.txt')).resolves.toBeNull();
    await expect(source.listItemFiles('chat-model', 'anything')).resolves.toEqual([]);
  });
});
