/**
 * Rebuild the immutable Handboek knowledge catalog shipped by gezeld, and the
 * `handboek.gezk.lock.json` beside it.
 *
 *   --if-stale  what the service build runs when the lock's input hash no
 *               longer matches: re-render, and rebuild only if the rendered
 *               content changed (otherwise just refresh the lock). See
 *               scripts/handboek-gezk-lock.mjs.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
  handboekKnowledgeFingerprint,
  handboekKnowledgeSource,
  siteDeviceInfo,
} from '@bendyline/gezel-service/handboek';
import {
  handboekInputsHash,
  readHandboekLock,
  writeHandboekLock,
} from '../../../scripts/handboek-gezk-lock.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
// The tree the lock's input hash covers. findHandboekContent() prefers
// dist/handboek-content, the copy the last service build staged, so a run
// outside the build rendered stale articles and locked them against new inputs.
const contentDir = join(root, 'docs', 'handboek');
if (!existsSync(join(contentDir, 'conceptual'))) {
  throw new Error(`Handboek content tree not found at ${contentDir}`);
}
const servicePackage = JSON.parse(
  await readFile(join(root, 'packages/service/package.json'), 'utf8'),
) as { version: string };
const engine = createHandboekEngine({
  catalog: new CatalogService(),
  device: siteDeviceInfo,
  contentDir,
});
const inputs = handboekInputsHash(root);
const source = await handboekKnowledgeSource(engine, contentDir);
const content = createHash('sha256')
  .update(
    `${handboekKnowledgeFingerprint(source)}\n${BGE_SMALL_EN_V15_1.id}\n${MARKDOWN_CHUNKS_2.id}\n`,
  )
  .digest('hex');
const outputPath = join(root, 'packages/service/assets/handboek/handboek.gezk');
if (process.argv.includes('--if-stale') && existsSync(outputPath)) {
  const lock = readHandboekLock(root);
  if (lock?.content === content) {
    writeHandboekLock({ inputs, content }, root);
    process.stdout.write('[handboek] rendered content unchanged; refreshed the lock only\n');
    process.exit(0);
  }
}
await mkdir(join(root, 'packages/service/assets/handboek'), { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), 'handboek-gezk-'));
const cacheDir =
  process.env.GEZEL_HF_CACHE_DIR ??
  join(process.env.GEZEL_HOME ?? join(homedir(), '.gezel'), 'engines/hf-cache');
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
  writeHandboekLock({ inputs, content }, root);
  process.stdout.write(
    `Wrote ${outputPath}: ${report.documents} documents, ${report.chunks} chunks, ${report.archiveBytes} bytes\n`,
  );
} finally {
  await embedder.dispose();
  await rm(workDir, { recursive: true, force: true });
}
