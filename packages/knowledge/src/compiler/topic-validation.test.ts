import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_PNG,
  fakeCountTokens,
  fakeEmbed,
} from '../test/fixture.js';
import { type CompileAsset, type CompileTopic, compileKnowledgeCatalog } from './compile.js';

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-compile-guards-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TREE: CompileTopic[] = [
  { id: 'craft', name: 'Craft' },
  { id: 'metals', name: 'Metals', parentId: 'craft' },
  { id: 'nature', name: 'Nature' },
];

function doc(patch: Partial<CatalogDocument> = {}): CatalogDocument {
  return {
    id: 'one',
    title: 'One',
    slug: 'one',
    language: 'en',
    topicPath: ['craft', 'metals'],
    markdown: '# One\n\nA short body about metals.\n',
    ...patch,
  };
}

async function compile(opts: {
  topics?: CompileTopic[];
  documents?: CatalogDocument[];
  assets?: CompileAsset[];
  extraFiles?: Record<string, string>;
}) {
  n += 1;
  return compileKnowledgeCatalog({
    catalog: {
      id: 'guards',
      version: '1.0.0',
      name: 'Guards',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: opts.topics ?? TREE,
    documents: (async function* () {
      for (const d of opts.documents ?? [doc()]) yield d;
    })(),
    outputPath: join(dir, `guards-${n}.gezk`),
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, `work-${n}`),
    ...(opts.assets ? { assets: opts.assets } : {}),
    ...(opts.extraFiles ? { extraFiles: opts.extraFiles } : {}),
  });
}

describe('topic forest and path validation', () => {
  it('files a document at the leaf of a declared path', async () => {
    const report = await compile({});
    expect(report.documents).toBe(1);
    expect(report.manifest.topics.map((t) => t.id)).toEqual(['craft', 'metals', 'nature']);
  });

  it('refuses an unknown segment, a broken chain, and a root used as a child', async () => {
    await expect(compile({ documents: [doc({ topicPath: ['craft', 'wood'] })] })).rejects.toThrow(
      /unknown topic 'wood'/,
    );
    await expect(
      compile({ documents: [doc({ topicPath: ['nature', 'metals'] })] }),
    ).rejects.toThrow(/does not follow the declared tree at 'metals'/);
    await expect(compile({ documents: [doc({ topicPath: ['metals'] })] })).rejects.toThrow(
      /does not follow the declared tree at 'metals'/,
    );
  });

  it('refuses duplicate ids, undeclared parents, cycles, and excessive depth', async () => {
    await expect(compile({ topics: [...TREE, { id: 'craft', name: 'Again' }] })).rejects.toThrow(
      /duplicate topic id: craft/,
    );
    await expect(
      compile({ topics: [{ id: 'craft', name: 'Craft', parentId: 'ghost' }] }),
    ).rejects.toThrow(/undeclared parent 'ghost'/);
    await expect(
      compile({
        topics: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' },
        ],
      }),
    ).rejects.toThrow(/parent cycle/);
    const deep: CompileTopic[] = Array.from({ length: 17 }, (_, i) => ({
      id: `t${i}`,
      name: `T${i}`,
      ...(i > 0 ? { parentId: `t${i - 1}` } : {}),
    }));
    await expect(compile({ topics: deep })).rejects.toThrow(/deeper than 16/);
  });
});

describe('metadata and asset guards', () => {
  it('bounds metadata and refuses values that cannot be canonicalized', async () => {
    await expect(
      compile({ documents: [doc({ meta: { blob: 'x'.repeat(17 * 1024) } })] }),
    ).rejects.toThrow(/bytes of metadata; the limit is 16384/);
    await expect(compile({ documents: [doc({ meta: { when: Number.NaN } })] })).rejects.toThrow(
      /cannot be serialized/,
    );
  });

  it('refuses bad asset paths, duplicates, wrong bytes, and active SVG', async () => {
    await expect(
      compile({ assets: [{ path: 'images/mark.png', content: FIXTURE_PNG }] }),
    ).rejects.toThrow(/invalid asset path/);
    await expect(
      compile({
        assets: [
          { path: 'assets/Mark.png', content: FIXTURE_PNG },
          { path: 'assets/mark.png', content: FIXTURE_PNG },
        ],
      }),
    ).rejects.toThrow(/duplicate asset path/);
    await expect(
      compile({ assets: [{ path: 'assets/mark.png', content: Buffer.from('not a png') }] }),
    ).rejects.toThrow(/leading bytes say unknown, the extension says png/);
    await expect(
      compile({
        assets: [
          {
            path: 'assets/live.svg',
            content: Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
            ),
          },
        ],
      }),
    ).rejects.toThrow(/not an inert SVG/);
    await expect(
      compile({ assets: [{ path: 'assets/mark.png', content: FIXTURE_PNG, absPath: '/x' }] }),
    ).rejects.toThrow(/exactly one of content/);
    await expect(compile({ extraFiles: { 'assets/notes.txt': 'x' } })).rejects.toThrow(
      /files under assets\/ go through 'assets'/,
    );
  });

  it('refuses a body that references an asset the archive does not ship', async () => {
    await expect(
      compile({ documents: [doc({ markdown: '# One\n\n![m](assets/missing.png)\n' })] }),
    ).rejects.toThrow(/references 'assets\/missing.png'/);
    const report = await compile({
      documents: [doc({ markdown: '# One\n\n![m](assets/mark.png)\n' })],
      assets: [{ path: 'assets/mark.png', content: FIXTURE_PNG }],
    });
    expect(report.manifest.counts.assets).toBe(1);
  });
});
