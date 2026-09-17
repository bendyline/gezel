import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.GEZEL_EMBED_MODEL ??= 'Xenova/all-MiniLM-L6-v2';
process.env.GEZEL_HF_CACHE_DIR ??= join(homedir(), '.cache', 'gezel-test-hf');

const { prewarmTestEmbedder } = await import('../src/test-support/prewarm-test-embedder.js');
await prewarmTestEmbedder();
process.stdout.write(
  `Verified ${process.env.GEZEL_EMBED_MODEL} in ${process.env.GEZEL_HF_CACHE_DIR}\n`,
);
