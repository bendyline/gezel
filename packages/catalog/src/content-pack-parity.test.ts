import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CatalogKind } from '@bendyline/gezel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunitySource } from './community-source.js';
import {
  CONTENT_PACK_FILENAME,
  collapseToContentPack,
  verifyContentPack,
  writeContentPack,
} from './content-pack.js';
import { gildeDataDir } from './gilde-data.js';
import { validateGildeContentUpgrade } from './live/validate.js';
import { CatalogService } from './service.js';
import { BundledSource, type CatalogSource } from './source.js';

/**
 * A packed root must be indistinguishable from the directory it replaced.
 * Every public read of both forms is compared for deep equality — through
 * the same `CatalogService` composition production uses (bundled tier loose,
 * community tier packed), and over the real pinned gilde community tier.
 */

const KINDS: CatalogKind[] = [
  'toolset',
  'gezel-template',
  'craftbook-template',
  'project-type',
  'connector-type',
  'chat-model',
  'image-model',
  'video-model',
  'knowledge-catalog',
];

const KIND_DIR: Partial<Record<CatalogKind, string>> = {
  toolset: 'toolsets',
  'gezel-template': 'gezel-templates',
  'craftbook-template': 'craftbook-templates',
};

async function put(root: string, rel: string, data: string | Buffer | object): Promise<void> {
  const path = join(root, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  const body =
    typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(path, body);
}

const toolsetIdentity = (id: string, extras: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'toolset',
  id,
  name: `${id} name`,
  description: `${id} fixture`,
  tags: ['fixture'],
  maintainer: { name: 'Test' },
  yankedVersions: [],
  ...extras,
});

const toolsetVersion = (version: string) => ({
  schemaVersion: 1,
  version,
  releasedAt: '2026-04-22T00:00:00Z',
  runtime: { kind: 'http-mcp', url: `https://example.com/${version}` },
  tools: [],
  config: [],
});

/** A catalog tier exercising every read path `BundledSource` has. */
async function seedTier(root: string, prefix: string): Promise<void> {
  const t = (id: string) => `toolsets/${id.slice(0, 2)}/${id}`;
  const a = `${prefix}a-tool`;
  await put(root, `${t(a)}/manifest.json`, toolsetIdentity(a, { logo: 'logo.svg' }));
  await put(root, `${t(a)}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put(root, `${t(a)}/readme.md`, `# ${a}\n\nShared across versions.\n`);
  await put(root, `${t(a)}/versions/1.0.0/manifest.json`, toolsetVersion('1.0.0'));
  await put(root, `${t(a)}/versions/1.1.0/manifest.json`, toolsetVersion('1.1.0'));
  await put(
    root,
    `${t(a)}/versions/1.1.0/icon.bin`,
    Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)),
  );

  const b = `${prefix}b-tool`;
  await put(root, `${t(b)}/manifest.json`, toolsetIdentity(b, { yankedVersions: ['2.0.0'] }));
  await put(root, `${t(b)}/versions/1.0.0/manifest.json`, toolsetVersion('1.0.0'));
  await put(root, `${t(b)}/versions/2.0.0/manifest.json`, toolsetVersion('2.0.0'));

  const c = `${prefix}c-tool`;
  await put(root, `${t(c)}/manifest.json`, toolsetIdentity(c));
  await put(root, `${t(c)}/versions/1.0.0/manifest.json`, '{ not json');

  const d = `${prefix}d-tool`;
  await put(root, `${t(d)}/manifest.json`, toolsetIdentity(d));
  await put(root, `${t(d)}/versions/1.0.0/manifest.json`, toolsetVersion('1.0.0'));
  await put(root, `${t(d)}/versions/1.1.0/manifest.json`, toolsetVersion('9.9.9'));

  // Listed by the index but with no folder: only the fast path sees it.
  await put(root, 'toolsets/index.json', {
    schemaVersion: 1,
    kind: 'toolset',
    count: 2,
    entries: [
      {
        manifest: {
          ...toolsetIdentity(a),
          ...toolsetVersion('1.1.0'),
          availableVersions: ['1.1.0', '1.0.0'],
        },
        iconSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
      },
      {
        manifest: {
          ...toolsetIdentity(`${prefix}z-indexed`),
          ...toolsetVersion('1.0.0'),
          availableVersions: ['1.0.0'],
        },
      },
    ],
  });

  const book = `${prefix}k-book`;
  const bookDir = `craftbook-templates/${book.slice(0, 2)}/${book}`;
  await put(root, `${bookDir}/manifest.json`, {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: book,
    name: `${book} name`,
    description: 'fixture',
    role: 'general',
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
  });
  await put(root, `${bookDir}/versions/1.0.0/craftbook.json`, {
    id: book,
    name: `${book} name`,
    description: 'INLINE PROSE',
    entryStepId: 'go',
    steps: [{ id: 'go', name: 'Go' }],
    scripts: { hello: 'export const meta = { name: "hello" };\n' },
    version: '1.0.0',
    releasedAt: '2026-04-22T00:00:00Z',
  });
  await put(root, `${bookDir}/versions/1.0.0/test.json`, { not: 'a valid spec' });

  const legacy = `${prefix}l-book`;
  const legacyDir = `craftbook-templates/${legacy.slice(0, 2)}/${legacy}`;
  await put(root, `${legacyDir}/manifest.json`, {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: legacy,
    name: `${legacy} name`,
    description: 'fixture',
    role: 'general',
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
  });
  await put(root, `${legacyDir}/versions/1.0.0/manifest.json`, {
    schemaVersion: 1,
    version: '1.0.0',
    releasedAt: '2026-04-22T00:00:00Z',
    about: 'about.md',
    entryStepId: 'go',
    steps: [{ id: 'go', name: 'Go' }],
    bundledScripts: ['hello.ts'],
  });
  await put(root, `${legacyDir}/versions/1.0.0/about.md`, '\uFEFFLEGACY PROSE\r\n');
  await put(root, `${legacyDir}/versions/1.0.0/scripts/hello.ts`, 'export default 1;\n');

  const tpl = `${prefix}h-tpl`;
  const tplDir = `gezel-templates/${tpl.slice(0, 2)}/${tpl}`;
  await put(root, `${tplDir}/manifest.json`, {
    schemaVersion: 1,
    kind: 'gezel-template',
    id: tpl,
    name: `${tpl} name`,
    description: 'fixture',
    tags: [],
    maintainer: { name: 'Test' },
    yankedVersions: [],
    role: 'Tester',
    meesterCandidate: false,
  });
  await put(root, `${tplDir}/versions/1.0.0/manifest.json`, {
    schemaVersion: 1,
    version: '1.0.0',
    releasedAt: '2026-04-22T00:00:00Z',
    about: 'about.md',
    suggestedTools: [],
  });
  await put(root, `${tplDir}/versions/1.0.0/about.md`, 'template prose');

  // A stray file where a kind directory is expected (ENOTDIR → empty).
  await put(root, 'chat-models', 'not a directory');
  await put(root, '.gitkeep', '');
}

const READ_PATHS = [
  'logo.svg',
  'readme.md',
  'icon.bin',
  'about.md',
  'manifest.json',
  'versions/1.0.0/manifest.json',
  'scripts/hello.ts',
  'craftbook.json',
  'missing.txt',
  '../escape',
  '/abs',
];

/** Every public read of `source`, keyed so two forms can be diffed. */
async function snapshot(source: CatalogSource | CatalogService, ids: Map<CatalogKind, string[]>) {
  const out: Record<string, unknown> = {};
  for (const kind of KINDS) {
    out[`list:${kind}`] = await source.list(kind);
    for (const id of ids.get(kind) ?? []) {
      const key = `${kind}/${id}`;
      out[`get:${key}`] = await source.get(kind, id);
      const versions = await source.listVersions(kind, id);
      out[`versions:${key}`] = versions;
      for (const version of [...versions.map((v) => v.version), '1.0.0', '9.9.9', undefined]) {
        const tag = `${key}@${version ?? 'latest'}`;
        if (version !== undefined) {
          out[`get:${tag}`] =
            source instanceof CatalogService
              ? await source.get(kind, id, undefined, version)
              : await source.get(kind, id, version);
        }
        for (const rel of READ_PATHS) {
          const buf =
            source instanceof CatalogService
              ? await source.readItemFile(kind, id, rel, undefined, version)
              : await source.readItemFile(kind, id, rel, version);
          out[`file:${tag}:${rel}`] = buf ? buf.toString('base64') : null;
        }
      }
      out[`files:${key}`] = await source.listItemFiles?.(kind, id);
      if (kind === 'craftbook-template') {
        out[`test:${key}`] = await source.getCraftbookTestSpec?.(id);
      }
    }
  }
  return out;
}

async function idsUnder(root: string): Promise<Map<CatalogKind, string[]>> {
  const ids = new Map<CatalogKind, string[]>();
  for (const [kind, dir] of Object.entries(KIND_DIR) as Array<[CatalogKind, string]>) {
    const found: string[] = [];
    for (const shard of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (shard === 'index.json') continue;
      found.push(...(await readdir(join(root, dir, shard))));
    }
    ids.set(kind, [...found, 'zz-nonexistent']);
  }
  return ids;
}

describe('content pack parity — fixture catalog', () => {
  let work: string;
  let looseRoot: string;
  let packedRoot: string;
  let ids: Map<CatalogKind, string[]>;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'gezel-pack-parity-'));
    looseRoot = join(work, 'loose', 'data');
    packedRoot = join(work, 'packed', 'data');
    await seedTier(looseRoot, 'bu');
    await seedTier(join(looseRoot, 'community'), 'co');
    await cp(looseRoot, packedRoot, { recursive: true });
    await collapseToContentPack(join(packedRoot, 'community'));
    const community = await idsUnder(join(looseRoot, 'community'));
    ids = await idsUnder(looseRoot);
    for (const [kind, list] of community) ids.set(kind, [...(ids.get(kind) ?? []), ...list]);
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('packs the community tier into a single file', async () => {
    expect(await readdir(join(packedRoot, 'community'))).toEqual([CONTENT_PACK_FILENAME]);
  });

  it('serves identical reads through the production CatalogService composition', async () => {
    const loose = new CatalogService(undefined, { contentRoot: () => looseRoot });
    const packed = new CatalogService(undefined, { contentRoot: () => packedRoot });
    const expected = await snapshot(loose, ids);
    // The fixture must actually reach the community tier, or parity is vacuous.
    expect(
      (expected['list:toolset'] as Array<{ sourceId: string }>).some(
        (i) => i.sourceId === 'community',
      ),
    ).toBe(true);
    expect(await snapshot(packed, ids)).toEqual(expected);
  });

  it('serves identical reads from a packed root with and without the index', async () => {
    for (const noIndex of [false, true]) {
      const loose = new CommunitySource(join(looseRoot, 'community'));
      const packed = new CommunitySource(join(packedRoot, 'community'));
      const looseSource = noIndex
        ? new BundledSource({ dataDir: join(looseRoot, 'community'), id: 'community', noIndex })
        : loose;
      const packedSource = noIndex
        ? new BundledSource({ dataDir: join(packedRoot, 'community'), id: 'community', noIndex })
        : packed;
      expect(await snapshot(packedSource, ids)).toEqual(await snapshot(looseSource, ids));
    }
  });

  it('gives the live-update regression gate the same verdict whichever form each side is', async () => {
    const baseline = await validateGildeContentUpgrade({
      currentDataDir: looseRoot,
      candidateDataDir: looseRoot,
    });
    // The index-only fixture entries have no folder to resolve, so the gate
    // flags exactly those — in every combination of forms.
    expect(baseline).toEqual({
      ok: false,
      regressions: [
        { kind: 'toolset', id: 'buz-indexed' },
        { kind: 'toolset', id: 'coz-indexed' },
      ],
    });
    for (const [current, candidate] of [
      [looseRoot, packedRoot],
      [packedRoot, looseRoot],
      [packedRoot, packedRoot],
    ] as const) {
      expect(
        await validateGildeContentUpgrade({ currentDataDir: current, candidateDataDir: candidate }),
      ).toEqual(baseline);
    }
  });
});

describe('content pack parity — the pinned gilde community tier', () => {
  const community = join(gildeDataDir(), 'community');
  let work: string;
  let packedRoot: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'gezel-pack-gilde-'));
    packedRoot = join(work, 'community');
    await mkdir(packedRoot);
    await writeContentPack(community, join(packedRoot, CONTENT_PACK_FILENAME));
  }, 300_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('carries every file of the tier byte for byte', async () => {
    const stats = await verifyContentPack(join(packedRoot, CONTENT_PACK_FILENAME), community);
    // Guards against a vacuous pass if the tier ever ships empty.
    expect(stats.files).toBeGreaterThan(1_000);
  }, 300_000);

  it('lists and resolves the same items as the directory', async () => {
    const loose = new CommunitySource(community);
    const packed = new CommunitySource(packedRoot);
    const listed = await loose.list('toolset');
    expect(listed.length).toBeGreaterThan(1_000);
    expect(await packed.list('toolset')).toEqual(listed);

    // Every item through the index is compared above; a deterministic spread
    // of them is also resolved through the per-item files.
    const step = Math.max(1, Math.floor(listed.length / 300));
    const sample = listed.filter((_, i) => i % step === 0 || i === listed.length - 1);
    for (const item of sample) {
      const id = item.manifest.id;
      expect(await packed.get('toolset', id)).toEqual(await loose.get('toolset', id));
      expect(await packed.listVersions('toolset', id)).toEqual(
        await loose.listVersions('toolset', id),
      );
      expect(await packed.listItemFiles('toolset', id)).toEqual(
        await loose.listItemFiles('toolset', id),
      );
    }
  }, 300_000);
});
