import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundledSource } from './source.js';

/**
 * Build a minimal bundled-data tree on disk so we can exercise the
 * version layout end-to-end. Each test gets its own temp dir.
 */
async function writeIdentity(root: string, kind: string, id: string, body: object) {
  const dir = join(root, `${kind}s`, id.slice(0, 2), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(body, null, 2));
  return dir;
}

async function writeVersion(itemDir: string, version: string, body: object) {
  const vdir = join(itemDir, 'versions', version);
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, 'manifest.json'), JSON.stringify(body, null, 2));
  return vdir;
}

const baseToolsetIdentity = (id: string, extras: Partial<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  kind: 'toolset',
  id,
  name: id,
  description: `${id} fixture`,
  tags: [],
  maintainer: { name: 'Test' },
  yankedVersions: [],
  ...extras,
});

const baseToolsetVersion = (version: string) => ({
  schemaVersion: 1,
  version,
  releasedAt: '2026-04-22T00:00:00Z',
  runtime: { kind: 'http-mcp', url: 'https://example.com/mcp' },
  tools: [],
  config: [],
});

describe('BundledSource — versioned layout', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-source-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('listVersions returns versions newest-first, with pre-releases ranked below their release', async () => {
    const dir = await writeIdentity(root, 'toolset', 'aa-tool', baseToolsetIdentity('aa-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.0.0-rc.1', baseToolsetVersion('1.0.0-rc.1'));
    await writeVersion(dir, '1.2.0', baseToolsetVersion('1.2.0'));
    await writeVersion(dir, '0.9.0', baseToolsetVersion('0.9.0'));
    const src = new BundledSource(root);
    const versions = await src.listVersions('toolset', 'aa-tool');
    expect(versions.map((v) => v.version)).toEqual(['1.2.0', '1.0.0', '1.0.0-rc.1', '0.9.0']);
    expect(versions.every((v) => v.yanked === false)).toBe(true);
  });

  it('listVersions marks yanked versions but still returns them', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'bb-tool',
      baseToolsetIdentity('bb-tool', { yankedVersions: ['1.1.0'] }),
    );
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.1.0', baseToolsetVersion('1.1.0'));
    await writeVersion(dir, '1.2.0', baseToolsetVersion('1.2.0'));
    const src = new BundledSource(root);
    const versions = await src.listVersions('toolset', 'bb-tool');
    const flag = Object.fromEntries(versions.map((v) => [v.version, v.yanked]));
    expect(flag).toEqual({ '1.0.0': false, '1.1.0': true, '1.2.0': false });
  });

  it('listVersions filters out anything below minSupportedVersion', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'cc-tool',
      baseToolsetIdentity('cc-tool', { minSupportedVersion: '1.0.0' }),
    );
    await writeVersion(dir, '0.5.0', baseToolsetVersion('0.5.0'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.1.0', baseToolsetVersion('1.1.0'));
    const src = new BundledSource(root);
    const versions = await src.listVersions('toolset', 'cc-tool');
    expect(versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
  });

  it('list resolves the highest non-yanked version into the resolved manifest', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'dd-tool',
      baseToolsetIdentity('dd-tool', { yankedVersions: ['1.2.0'] }),
    );
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.2.0', baseToolsetVersion('1.2.0'));
    await writeVersion(dir, '1.1.0', baseToolsetVersion('1.1.0'));
    const src = new BundledSource(root);
    const items = await src.list('toolset');
    expect(items).toHaveLength(1);
    const m = items[0]?.manifest;
    if (!m || m.kind !== 'toolset') throw new Error('expected toolset manifest');
    expect(m.version).toBe('1.1.0');
    // availableVersions excludes yanked ones, sorted high-to-low.
    expect(m.availableVersions).toEqual(['1.1.0', '1.0.0']);
  });

  it('preserves connector setup guidance when resolving identity and version layers', async () => {
    const dir = await writeIdentity(root, 'connector-type', 'bluesky-posts', {
      schemaVersion: 1,
      kind: 'connector-type',
      id: 'bluesky-posts',
      name: 'Bluesky Posts',
      description: 'Bluesky fixture',
      tags: [],
      maintainer: { name: 'Test' },
    });
    await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-08-13T00:00:00Z',
      driver: 'native',
      source: { adapterId: 'bluesky-posts' },
      setupInstructions: {
        title: 'Create a Bluesky app password',
        steps: ['Open Bluesky settings.', 'Create an app password for Gezel.'],
        url: 'https://bsky.app/settings/app-passwords',
        urlLabel: 'Open Bluesky settings',
      },
    });

    const detail = await new BundledSource(root).get('connector-type', 'bluesky-posts');
    if (!detail || detail.manifest.kind !== 'connector-type') {
      throw new Error('expected connector-type detail');
    }
    expect(detail.manifest.setupInstructions).toEqual({
      title: 'Create a Bluesky app password',
      steps: ['Open Bluesky settings.', 'Create an app password for Gezel.'],
      url: 'https://bsky.app/settings/app-passwords',
      urlLabel: 'Open Bluesky settings',
    });
  });

  it('get with explicit version returns that version even when yanked', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'ee-tool',
      baseToolsetIdentity('ee-tool', { yankedVersions: ['1.2.0'] }),
    );
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.2.0', baseToolsetVersion('1.2.0'));
    const src = new BundledSource(root);
    const detail = await src.get('toolset', 'ee-tool', '1.2.0');
    if (!detail) throw new Error('expected detail');
    expect(detail.manifest.version).toBe('1.2.0');
  });

  it('get with missing version returns null', async () => {
    const dir = await writeIdentity(root, 'toolset', 'ff-tool', baseToolsetIdentity('ff-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    const src = new BundledSource(root);
    expect(await src.get('toolset', 'ff-tool', '9.9.9')).toBeNull();
  });

  it('get returns null when no versions exist on disk', async () => {
    await writeIdentity(root, 'toolset', 'gg-tool', baseToolsetIdentity('gg-tool'));
    const src = new BundledSource(root);
    expect(await src.get('toolset', 'gg-tool')).toBeNull();
    expect(await src.listVersions('toolset', 'gg-tool')).toEqual([]);
  });

  it('readItemFile prefers the version subfolder, falls back to item root', async () => {
    const dir = await writeIdentity(root, 'gezel-template', 'hh-tpl', {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'hh-tpl',
      name: 'HH',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role: 'Tester',
      meesterCandidate: false,
    });
    const v1 = await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
    });
    await writeFile(join(v1, 'about.md'), 'v1 about');
    await writeFile(join(dir, 'logo.svg'), '<svg/>');

    const src = new BundledSource(root);

    // Versioned path lookup hits the version folder.
    const aboutBuf = await src.readItemFile('gezel-template', 'hh-tpl', 'about.md', '1.0.0');
    expect(aboutBuf?.toString('utf8')).toBe('v1 about');

    // Shared asset (logo.svg) lives only at the item root — version
    // lookup must fall through.
    const logoBuf = await src.readItemFile('gezel-template', 'hh-tpl', 'logo.svg', '1.0.0');
    expect(logoBuf?.toString('utf8')).toBe('<svg/>');

    // Path traversal is rejected even with a version supplied.
    expect(
      await src.readItemFile('gezel-template', 'hh-tpl', '../../../etc/passwd', '1.0.0'),
    ).toBeNull();

    // Non-semver version string → reject (would otherwise let a caller
    // smuggle a path segment).
    expect(
      await src.readItemFile('gezel-template', 'hh-tpl', 'about.md', '1.0.0/../..'),
    ).toBeNull();
  });

  it('skips a version folder whose manifest version mismatches the folder name', async () => {
    const dir = await writeIdentity(root, 'toolset', 'ii-tool', baseToolsetIdentity('ii-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    // Folder is 1.1.0 but the manifest claims 9.9.9 — discoverVersionFolders should reject.
    await writeVersion(dir, '1.1.0', baseToolsetVersion('9.9.9'));
    const src = new BundledSource(root);
    const versions = await src.listVersions('toolset', 'ii-tool');
    expect(versions.map((v) => v.version)).toEqual(['1.0.0']);
  });

  it('list reads from index.json when present and skips the disk walk', async () => {
    // Build a real index file by hand. The runtime's job is to trust
    // it — the format match is the build-script's responsibility.
    await mkdir(join(root, 'toolsets'), { recursive: true });
    const indexPayload = {
      schemaVersion: 1,
      kind: 'toolset',
      count: 2,
      entries: [
        {
          iconSvg:
            '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script><image href="https://attacker.test/pixel"/><path d="M0 0h1v1z" style="fill:url(https://attacker.test/paint)"/></svg>',
          manifest: {
            schemaVersion: 1,
            kind: 'toolset',
            id: 'zz-from-index',
            name: 'ZZ From Index',
            description: 'should appear without a folder existing',
            tags: ['indexed'],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            runtime: { kind: 'http-mcp', url: 'https://example.com/zz' },
            tools: [],
            config: [],
            availableVersions: ['1.0.0'],
            category: 'search',
          },
        },
        {
          iconSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>only content</script></svg>',
          manifest: {
            schemaVersion: 1,
            kind: 'toolset',
            id: 'aa-from-index',
            name: 'AA From Index',
            description: 'second',
            tags: [],
            maintainer: { name: 'Test' },
            version: '1.0.0',
            releasedAt: '2026-04-22T00:00:00Z',
            runtime: { kind: 'http-mcp', url: 'https://example.com/aa' },
            tools: [],
            config: [],
            availableVersions: ['1.0.0'],
          },
        },
      ],
    };
    await writeFile(join(root, 'toolsets', 'index.json'), JSON.stringify(indexPayload));

    const src = new BundledSource({ dataDir: root, id: 'community' });
    const items = await src.list('toolset');
    // Both entries are surfaced and sorted alphabetically by name.
    expect(items.map((i) => i.manifest.id)).toEqual(['aa-from-index', 'zz-from-index']);
    // Source id is re-stamped from the runtime source, not the index.
    expect(items.every((i) => i.sourceId === 'community')).toBe(true);
    // Category passes through.
    const zz = items.find((i) => i.manifest.id === 'zz-from-index');
    if (!zz || zz.manifest.kind !== 'toolset') throw new Error('expected toolset');
    expect(zz.manifest.category).toBe('search');
    expect(zz.iconSvg).toContain('<path d="M0 0h1v1z"/>');
    expect(zz.iconSvg).not.toContain('script');
    expect(zz.iconSvg).not.toContain('image');
    expect(zz.iconSvg).not.toContain('attacker.test');
    expect(items.find((item) => item.manifest.id === 'aa-from-index')?.iconSvg).toBeUndefined();
  });

  it('list with noIndex skips the index file even when present', async () => {
    // Write an index that points to a phantom item, plus one real
    // item on disk. The slow path should ignore the index and only
    // see the real one.
    const dir = await writeIdentity(root, 'toolset', 'kk-tool', baseToolsetIdentity('kk-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeFile(
      join(root, 'toolsets', 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'toolset',
        entries: [
          {
            manifest: {
              schemaVersion: 1,
              kind: 'toolset',
              id: 'phantom',
              name: 'Phantom',
              description: 'only in index',
              tags: [],
              maintainer: { name: 'Test' },
              version: '1.0.0',
              releasedAt: '2026-04-22T00:00:00Z',
              runtime: { kind: 'http-mcp', url: 'https://example.com/p' },
              tools: [],
              config: [],
              availableVersions: ['1.0.0'],
            },
          },
        ],
      }),
    );

    const src = new BundledSource({ dataDir: root, noIndex: true });
    const items = await src.list('toolset');
    expect(items.map((i) => i.manifest.id)).toEqual(['kk-tool']);
  });

  it('skips a chat-model version with no source block', async () => {
    const dir = await writeIdentity(root, 'chat-model', 'jj-model', {
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'jj-model',
      name: 'JJ',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      parameterSize: '1B',
      supportsTools: false,
    });
    await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      approxSizeBytes: 100,
      // no ollama / llamaCpp / mlx / ds4
    });
    const src = new BundledSource(root);
    expect(await src.get('chat-model', 'jj-model')).toBeNull();
  });

  it('loads a chat-model version whose only source is ds4', async () => {
    const dir = await writeIdentity(root, 'chat-model', 'ds4-only', {
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'ds4-only',
      name: 'ds4 only',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'Test' },
      maker: { name: 'Core Model Co', url: 'https://example.com/core-model' },
      yankedVersions: [],
      parameterSize: '1B',
      supportsTools: false,
    });
    await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      approxSizeBytes: 100,
      ds4: {
        huggingfaceRepo: 'example/ds4-model',
        filename: 'model.gguf',
        sha256: 'a'.repeat(64),
        approxSizeBytes: 100,
      },
    });
    const src = new BundledSource(root);
    const found = await src.get('chat-model', 'ds4-only');
    expect(found?.manifest.kind).toBe('chat-model');
    if (found?.manifest.kind !== 'chat-model') throw new Error('expected chat-model fixture');
    expect(found.manifest.maker).toEqual({
      name: 'Core Model Co',
      url: 'https://example.com/core-model',
    });
    expect(found.manifest.ds4?.filename).toBe('model.gguf');
  });
});

describe('BundledSource — minGezelVersion gating', () => {
  let root: string;
  // A stamped date-based build (2026 day-200) — floors above/below it
  // exercise both sides of the gate.
  const APP = '1.26200.3';
  // Inject the dev sentinel explicitly. Release CI stamps GEZEL_VERSION in
  // core before running this suite, so relying on the imported default makes
  // these tests change meaning according to the workflow that invoked them.
  const DEV = '0.0.0';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-mingezel-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('an identity-level floor above this build hides the item from list, get, and listVersions', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'ga-tool',
      baseToolsetIdentity('ga-tool', { minGezelVersion: '1.26290' }),
    );
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    expect(await src.list('toolset')).toEqual([]);
    expect(await src.get('toolset', 'ga-tool')).toBeNull();
    expect(await src.listVersions('toolset', 'ga-tool')).toEqual([]);
  });

  it('an identity-level floor at or below this build leaves the item visible and stamps the resolved floor', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'gb-tool',
      baseToolsetIdentity('gb-tool', { minGezelVersion: '1.26100' }),
    );
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    const items = await src.list('toolset');
    expect(items.map((i) => i.manifest.id)).toEqual(['gb-tool']);
    expect(items[0]?.manifest.minGezelVersion).toBe('1.26100');
  });

  it('a gated newest version falls back to the older eligible version', async () => {
    const dir = await writeIdentity(root, 'toolset', 'gc-tool', baseToolsetIdentity('gc-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.1.0', {
      ...baseToolsetVersion('1.1.0'),
      minGezelVersion: '1.26290',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    const detail = await src.get('toolset', 'gc-tool');
    expect(detail?.manifest.version).toBe('1.0.0');
    expect(detail?.manifest.availableVersions).toEqual(['1.0.0']);
    const versions = await src.listVersions('toolset', 'gc-tool');
    expect(versions.map((v) => v.version)).toEqual(['1.0.0']);
  });

  it('an item whose every version is gated drops out of list and get, quietly', async () => {
    const dir = await writeIdentity(root, 'toolset', 'gd-tool', baseToolsetIdentity('gd-tool'));
    await writeVersion(dir, '1.0.0', {
      ...baseToolsetVersion('1.0.0'),
      minGezelVersion: '1.26290',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    expect(await src.list('toolset')).toEqual([]);
    expect(await src.get('toolset', 'gd-tool')).toBeNull();
  });

  it('an explicit version pin bypasses the version-level gate (like yanked versions)', async () => {
    const dir = await writeIdentity(root, 'toolset', 'ge-tool', baseToolsetIdentity('ge-tool'));
    await writeVersion(dir, '1.1.0', {
      ...baseToolsetVersion('1.1.0'),
      minGezelVersion: '1.26290',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    const detail = await src.get('toolset', 'ge-tool', '1.1.0');
    expect(detail?.manifest.version).toBe('1.1.0');
  });

  it('an unstamped dev build (0.0.0) never filters', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'gf-tool',
      baseToolsetIdentity('gf-tool', { minGezelVersion: '1.99999' }),
    );
    await writeVersion(dir, '1.0.0', {
      ...baseToolsetVersion('1.0.0'),
      minGezelVersion: '1.99999',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: DEV });
    const items = await src.list('toolset');
    expect(items.map((i) => i.manifest.id)).toEqual(['gf-tool']);
  });

  it('the resolved manifest carries the effective floor — the stricter of identity and version', async () => {
    const dir = await writeIdentity(
      root,
      'toolset',
      'gg2-tool',
      baseToolsetIdentity('gg2-tool', { minGezelVersion: '1.26100' }),
    );
    await writeVersion(dir, '1.0.0', {
      ...baseToolsetVersion('1.0.0'),
      minGezelVersion: '1.26150',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    const detail = await src.get('toolset', 'gg2-tool');
    expect(detail?.manifest.minGezelVersion).toBe('1.26150');
  });

  it('the craftbook.json doc path gates and stamps the effective floor too', async () => {
    const dir = await writeIdentity(root, 'craftbook-template', 'gh-book', {
      schemaVersion: 1,
      kind: 'craftbook-template',
      id: 'gh-book',
      name: 'gh book',
      description: 'fixture',
      role: 'general',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    });
    const writeDoc = async (version: string, floor?: string) => {
      const vdir = join(dir, 'versions', version);
      await mkdir(vdir, { recursive: true });
      await writeFile(
        join(vdir, 'craftbook.json'),
        JSON.stringify({
          id: 'gh-book',
          name: 'gh book',
          steps: [{ id: 'go', name: 'Go' }],
          version,
          releasedAt: '2026-04-22T00:00:00Z',
          ...(floor ? { minGezelVersion: floor } : {}),
        }),
      );
    };
    await writeDoc('1.0.0');
    await writeDoc('1.1.0', '1.26290');
    const src = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: APP });
    const detail = await src.get('craftbook-template', 'gh-book');
    expect(detail?.manifest.version).toBe('1.0.0');
    expect(detail?.manifest.minGezelVersion).toBeUndefined();

    const dev = new BundledSource({ dataDir: root, noIndex: true, gezelVersion: DEV });
    const devDetail = await dev.get('craftbook-template', 'gh-book');
    expect(devDetail?.manifest.version).toBe('1.1.0');
    expect(devDetail?.manifest.minGezelVersion).toBe('1.26290');
  });

  it('a gated index entry falls back to disk resolution of an older eligible version', async () => {
    const dir = await writeIdentity(root, 'toolset', 'gi-tool', baseToolsetIdentity('gi-tool'));
    await writeVersion(dir, '1.0.0', baseToolsetVersion('1.0.0'));
    await writeVersion(dir, '1.1.0', {
      ...baseToolsetVersion('1.1.0'),
      minGezelVersion: '1.26290',
    });
    // The index embeds the newest resolved version (the index builder has
    // no app-version context) — exactly what a gilde build-index produces.
    await writeFile(
      join(root, 'toolsets', 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'toolset',
        count: 2,
        entries: [
          {
            manifest: {
              schemaVersion: 1,
              kind: 'toolset',
              id: 'gi-tool',
              name: 'gi-tool',
              description: 'gi-tool fixture',
              tags: [],
              maintainer: { name: 'Test' },
              minGezelVersion: '1.26290',
              version: '1.1.0',
              releasedAt: '2026-04-22T00:00:00Z',
              runtime: { kind: 'http-mcp', url: 'https://example.com/mcp' },
              tools: [],
              config: [],
              availableVersions: ['1.1.0', '1.0.0'],
            },
          },
          {
            manifest: {
              schemaVersion: 1,
              kind: 'toolset',
              id: 'phantom-gated',
              name: 'Phantom Gated',
              description: 'index-only, gated, no disk folder to fall back to',
              tags: [],
              maintainer: { name: 'Test' },
              minGezelVersion: '1.26290',
              version: '1.0.0',
              releasedAt: '2026-04-22T00:00:00Z',
              runtime: { kind: 'http-mcp', url: 'https://example.com/p' },
              tools: [],
              config: [],
              availableVersions: ['1.0.0'],
            },
          },
        ],
      }),
    );
    const src = new BundledSource({ dataDir: root, gezelVersion: APP });
    const items = await src.list('toolset');
    // gi-tool re-resolves from disk to 1.0.0; the fully-gated phantom drops.
    expect(items.map((i) => i.manifest.id)).toEqual(['gi-tool']);
    expect(items[0]?.manifest.version).toBe('1.0.0');

    // A dev build serves the index entries untouched.
    const dev = new BundledSource({ dataDir: root, gezelVersion: DEV });
    const devItems = await dev.list('toolset');
    expect(devItems.map((i) => i.manifest.id).sort()).toEqual(['gi-tool', 'phantom-gated']);
    expect(devItems.find((i) => i.manifest.id === 'gi-tool')?.manifest.version).toBe('1.1.0');
  });
});

describe('BundledSource — which version floors are compared against', () => {
  it('defaults to the calendar line, never the published version', async () => {
    // Asserted against the source because the two constants are both '0.0.0'
    // in a dev checkout, so no runtime observation can tell them apart here —
    // the difference only appears on a stamped release build, which is exactly
    // where getting it wrong is expensive.
    //
    // Gating on GEZEL_VERSION put npm builds below every `1.YYDDD` floor
    // (floored content silently vanished) and would have put a future 2.x
    // above all of them. GEZEL_CONTENT_COMPAT is stamped on the calendar line
    // by both release paths; see scripts/calver.mjs.
    const source = await readFile(new URL('./source.ts', import.meta.url), 'utf8');
    expect(source).toContain('opts.gezelVersion ?? GEZEL_CONTENT_COMPAT');
    expect(source).not.toMatch(/opts\.gezelVersion \?\? GEZEL_VERSION/);
  });
});

describe('BundledSource — craftbook template layouts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-craftbook-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const craftbookIdentity = (
    id: string,
    role: 'project-starter' | 'maintenance-review' | 'general' = 'general',
  ) => ({
    schemaVersion: 1,
    kind: 'craftbook-template',
    id,
    name: `${id} book`,
    description: `${id} fixture`,
    role,
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
  });

  const SCRIPT_SOURCE = 'export const meta = { name: "hello" };\n';

  it('resolves the V2 single-document layout: craftbook.json only', async () => {
    const dir = await writeIdentity(
      root,
      'craftbook-template',
      'kk-book',
      craftbookIdentity('kk-book', 'project-starter'),
    );
    const vdir = join(dir, 'versions', '1.0.0');
    await mkdir(vdir, { recursive: true });
    await writeFile(
      join(vdir, 'craftbook.json'),
      JSON.stringify({
        id: 'kk-book',
        name: 'kk-book book',
        description: 'THE INLINE PROSE',
        basedOn: { name: 'Fixture upstream', url: 'https://example.com/fixture' },
        runModes: { scheduled: 'recommended', nightShift: 'supported' },
        recommends: [{ kind: 'external-services', reason: 'fetches live pages' }],
        connectors: [
          {
            typeId: 'github-pulls',
            reason: 'Mirror the pull request before review.',
          },
        ],
        entryStepId: 'go',
        steps: [{ id: 'go', name: 'Go' }],
        scripts: { hello: SCRIPT_SOURCE },
        version: '1.0.0',
        releasedAt: '2026-04-22T00:00:00Z',
      }),
    );
    const src = new BundledSource({ dataDir: root, noIndex: true });
    const versions = await src.listVersions('craftbook-template', 'kk-book');
    expect(versions.map((v) => v.version)).toEqual(['1.0.0']);
    const detail = await src.get('craftbook-template', 'kk-book');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'craftbook-template') throw new Error('wrong kind');
    expect(detail.manifest.entryStepId).toBe('go');
    expect(detail.manifest.role).toBe('project-starter');
    expect(detail.manifest.basedOn).toEqual({
      name: 'Fixture upstream',
      url: 'https://example.com/fixture',
    });
    expect(detail.manifest.runModes).toEqual({
      scheduled: 'recommended',
      nightShift: 'supported',
    });
    expect(detail.manifest.recommends).toEqual([
      { kind: 'external-services', reason: 'fetches live pages' },
    ]);
    expect(detail.manifest.connectors).toEqual([
      {
        typeId: 'github-pulls',
        reason: 'Mirror the pull request before review.',
      },
    ]);
    expect(detail.manifest.steps.map((s) => s.id)).toEqual(['go']);
    expect(detail.manifest.scripts).toEqual({ hello: SCRIPT_SOURCE });
    expect(detail.manifest.bundledScripts).toEqual(['hello.ts']);
    expect(detail.about).toBe('THE INLINE PROSE');
    // Scripts are served synthetically from the doc — no physical file.
    const buf = await src.readItemFile(
      'craftbook-template',
      'kk-book',
      'scripts/hello.ts',
      '1.0.0',
    );
    expect(buf?.toString('utf8')).toBe(SCRIPT_SOURCE);
  });

  it('still resolves the legacy layout (manifest.json + about.md + scripts/)', async () => {
    const dir = await writeIdentity(
      root,
      'craftbook-template',
      'll-book',
      craftbookIdentity('ll-book'),
    );
    const vdir = await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      about: 'about.md',
      runModes: { scheduled: 'supported' },
      entryStepId: 'go',
      steps: [{ id: 'go', name: 'Go' }],
      bundledScripts: ['hello.ts'],
    });
    await writeFile(join(vdir, 'about.md'), 'LEGACY PROSE');
    await mkdir(join(vdir, 'scripts'), { recursive: true });
    await writeFile(join(vdir, 'scripts', 'hello.ts'), SCRIPT_SOURCE);
    const src = new BundledSource({ dataDir: root, noIndex: true });
    const detail = await src.get('craftbook-template', 'll-book');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'craftbook-template') throw new Error('wrong kind');
    expect(detail.manifest.entryStepId).toBe('go');
    expect(detail.manifest.role).toBe('general');
    expect(detail.manifest.runModes).toEqual({ scheduled: 'supported' });
    expect(detail.manifest.bundledScripts).toEqual(['hello.ts']);
    expect(detail.manifest.scripts).toBeUndefined();
    expect(detail.about).toBe('LEGACY PROSE');
    const buf = await src.readItemFile(
      'craftbook-template',
      'll-book',
      'scripts/hello.ts',
      '1.0.0',
    );
    expect(buf?.toString('utf8')).toBe(SCRIPT_SOURCE);
  });

  it('an invalid craftbook.json is a hard miss — no silent fallback to a stale legacy manifest', async () => {
    const dir = await writeIdentity(
      root,
      'craftbook-template',
      'mm-book',
      craftbookIdentity('mm-book'),
    );
    const vdir = await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-04-22T00:00:00Z',
      about: '',
      entryStepId: 'go',
      steps: [{ id: 'go', name: 'Go' }],
    });
    await writeFile(join(vdir, 'craftbook.json'), JSON.stringify({ name: 'broken' }));
    const src = new BundledSource({ dataDir: root, noIndex: true });
    expect(await src.get('craftbook-template', 'mm-book')).toBeNull();
  });
});

describe('BundledSource — project types', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-project-type-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const projectTypeIdentity = (id: string) => ({
    schemaVersion: 1,
    kind: 'project-type',
    id,
    name: `${id} type`,
    description: `${id} fixture`,
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
  });

  it('resolves a minimal project type and fills composition defaults', async () => {
    const dir = await writeIdentity(root, 'project-type', 'nn-type', {
      ...projectTypeIdentity('nn-type'),
      icon: 'server',
    });
    await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      extends: 'email',
      aboutTemplate: 'about.md',
    });
    const src = new BundledSource({ dataDir: root, noIndex: true });
    const detail = await src.get('project-type', 'nn-type');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('wrong kind');
    expect(detail.manifest.extends).toBe('email');
    expect(detail.manifest.icon).toBe('server');
    expect(detail.manifest.gezels).toEqual([]);
    expect(detail.manifest.toolsets).toEqual([]);
    expect(detail.manifest.tools).toEqual([]);
    expect(detail.manifest.availableVersions).toEqual(['1.0.0']);
  });

  it('surfaces the aboutTemplate content as the detail about preview', async () => {
    const dir = await writeIdentity(
      root,
      'project-type',
      'oo-type',
      projectTypeIdentity('oo-type'),
    );
    const vdir = await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      aboutTemplate: 'about.md',
    });
    await writeFile(join(vdir, 'about.md'), 'PROJECT TYPE PROSE');
    const src = new BundledSource({ dataDir: root, noIndex: true });
    const detail = await src.get('project-type', 'oo-type');
    expect(detail?.about).toBe('PROJECT TYPE PROSE');
  });

  it('carries the full composition through list + get', async () => {
    const dir = await writeIdentity(
      root,
      'project-type',
      'pp-type',
      projectTypeIdentity('pp-type'),
    );
    await writeVersion(dir, '1.0.0', {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      meesterManaged: false,
      indexingEnabled: false,
      nameTemplate: '{{topic}} pp-type',
      gezels: [{ templateId: 'language-trainer', voorman: true }],
      toolsets: [{ id: 'web-search', need: 'suggested', autoAllow: ['search'] }],
      craftbooks: ['daily-lesson'],
      tools: [{ name: 'advance_level', description: 'Advance.', script: 'progress-store' }],
      pages: { entry: 'dashboard/index.html' },
      schedules: [{ cron: '0 18 * * *', craftbook: 'daily-lesson', consent: 'ask' }],
      workspaceSeed: ['progress.json'],
    });
    const src = new BundledSource({ dataDir: root, noIndex: true });
    const items = await src.list('project-type');
    expect(items).toHaveLength(1);
    const m = items[0]?.manifest;
    if (!m || m.kind !== 'project-type') throw new Error('expected project-type manifest');
    expect(m.gezels[0]?.templateId).toBe('language-trainer');
    expect(m.meesterManaged).toBe(false);
    expect(m.indexingEnabled).toBe(false);
    expect(m.nameTemplate).toBe('{{topic}} pp-type');
    expect(m.tools[0]?.name).toBe('advance_level');
    expect(m.pages?.entry).toBe('dashboard/index.html');
    expect(m.schedules[0]?.craftbook).toBe('daily-lesson');
    expect(m.workspaceSeed).toEqual(['progress.json']);
  });
});

describe('BundledSource — absent vs. failed directory reads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-absent-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a missing kind directory lists as empty (not an error)', async () => {
    const src = new BundledSource({ dataDir: root, noIndex: true });
    await expect(src.list('chat-model')).resolves.toEqual([]);
  });

  it('a stray file where a kind directory is expected lists as empty', async () => {
    // A file (not a directory) at `{root}/chat-models` makes readdir throw
    // ENOTDIR — a benign "nothing to enumerate here", not an I/O failure.
    await writeFile(join(root, 'chat-models'), 'not a directory');
    const src = new BundledSource({ dataDir: root, noIndex: true });
    await expect(src.list('chat-model')).resolves.toEqual([]);
  });
});

describe('BundledSource — dynamic root provider', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    rootA = await mkdtemp(join(tmpdir(), 'catalog-provider-a-'));
    rootB = await mkdtemp(join(tmpdir(), 'catalog-provider-b-'));
  });

  afterEach(async () => {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });

  it('follows a provider flip without reconstruction', async () => {
    const dirA = await writeIdentity(rootA, 'toolset', 'aa-tool', baseToolsetIdentity('aa-tool'));
    await writeVersion(dirA, '1.0.0', baseToolsetVersion('1.0.0'));
    const dirB = await writeIdentity(rootB, 'toolset', 'bb-tool', baseToolsetIdentity('bb-tool'));
    await writeVersion(dirB, '2.0.0', baseToolsetVersion('2.0.0'));

    let active = rootA;
    const src = new BundledSource({ dataDir: () => active, noIndex: true });
    expect((await src.list('toolset')).map((i) => i.manifest.id)).toEqual(['aa-tool']);
    expect(await src.get('toolset', 'bb-tool')).toBeNull();

    active = rootB;
    expect((await src.list('toolset')).map((i) => i.manifest.id)).toEqual(['bb-tool']);
    expect((await src.get('toolset', 'bb-tool'))?.manifest.version).toBe('2.0.0');
    expect(await src.get('toolset', 'aa-tool')).toBeNull();
  });
});
