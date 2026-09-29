/** Rebuild the immutable Handboek knowledge catalog shipped by gezeld. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import {
  BGE_SMALL_EN_V15_1,
  MARKDOWN_CHUNKS_2,
  compileKnowledgeCatalog,
  createProfileEmbedder,
} from '@bendyline/gezel-knowledge';
import {
  HANDBOEK_KNOWLEDGE_CATALOG,
  HANDBOEK_KNOWLEDGE_PUBLISHER,
  createHandboekEngine,
  findHandboekContent,
  handboekKnowledgeSource,
  siteDeviceInfo,
} from '@bendyline/gezel-service/handboek';

const root = resolve(import.meta.dirname, '..', '..', '..');
const contentDir = findHandboekContent();
if (!contentDir) throw new Error('Handboek content tree not found');
const servicePackage = JSON.parse(
  await readFile(join(root, 'packages/service/package.json'), 'utf8'),
) as { version: string };
const engine = createHandboekEngine({
  catalog: new CatalogService(),
  device: siteDeviceInfo,
  contentDir,
});
const source = await handboekKnowledgeSource(engine, contentDir);
const outputPath = join(root, 'packages/service/assets/handboek/handboek.gezk');
await mkdir(join(root, 'packages/service/assets/handboek'), { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), 'handboek-gezk-'));
const cacheDir =
  process.env.GEZEL_HF_CACHE_DIR ??
  join(process.env.GEZEL_HOME ?? join(process.env.USERPROFILE ?? '', '.gezel'), 'engines/hf-cache');
const embedder = await createProfileEmbedder(BGE_SMALL_EN_V15_1, { cacheDir });
try {
  const report = await compileKnowledgeCatalog({
    catalog: {
      id: HANDBOEK_KNOWLEDGE_CATALOG,
      version: servicePackage.version,
      name: 'Gezel Handboek',
      description: 'The guide to gezel, its crew, projects, craftbooks, and tools.',
      language: 'en',
      publisher: { id: HANDBOEK_KNOWLEDGE_PUBLISHER, name: 'Bendyline', url: 'https://gezel.com' },
      createdAt: '2026-09-26T00:00:00.000Z',
      license: { name: 'MIT', spdx: 'MIT', attributionRequired: false },
    },
    topics: source.topics,
    documents: (async function* () {
      yield* source.documents;
    })(),
    assets: source.assets,
    outputPath,
    workDir,
    embeddingProfile: embedder.profile,
    chunkingProfile: MARKDOWN_CHUNKS_2,
    embed: (texts) => embedder.embed(texts),
    countTokens: (text) => embedder.countTokens(text),
    extraFiles: {
      'README.md':
        'Gezel Handboek. Source: https://github.com/bendyline/gezel/tree/main/docs/handboek. The website HTML is generated separately from that source tree.\n',
      'LICENSES/catalog.txt':
        'MIT License. Copyright Bendyline. https://github.com/bendyline/gezel/blob/main/LICENSE\n',
    },
    onProgress: ({ phase, done, total }) => {
      if (total > 0 && done % 100 === 0) process.stdout.write(`${phase}: ${done}/${total}\n`);
    },
  });
  process.stdout.write(
    `Wrote ${outputPath}: ${report.documents} documents, ${report.chunks} chunks, ${report.archiveBytes} bytes\n`,
  );
} finally {
  await embedder.dispose();
  await rm(workDir, { recursive: true, force: true });
}
