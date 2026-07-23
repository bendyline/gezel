import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Embedding defaults for tests:
 *
 * - `GEZEL_EMBED_MODEL`: production defaults to bge-small-en-v1.5 (~130 MB),
 *   but tests exercise embedding PLUMBING, not retrieval quality — pin the
 *   small MiniLM model (~23 MB) so no test pays the bge cold download. Tests
 *   asserting the production default (embed-model.test.ts) `delete` this first;
 *   the index-bench measures the real embedder out-of-band.
 * - `GEZEL_HF_CACHE_DIR`: a single shared model cache so the embedder downloads
 *   ONCE across all test files instead of per fresh test home. The service's
 *   `??=` respects it. Without this, each embedding-integration file re-fetches
 *   the model (~8-16 s), which pushed the marginal mcp-bridge round-trip over
 *   its 30 s timeout under full-suite CPU contention.
 */
export default defineConfig({
  test: {
    // Vitest 4 defaults to nearly every available core. This suite has many
    // integration files that each boot services, subprocesses, and embedding
    // workers; running 17 forks on an 18-core workstation can make a worker
    // exit after otherwise-successful tests. Keep enough parallelism for a
    // quick run without multiplying those process trees without bound.
    maxWorkers: 8,
    env: {
      GEZEL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
      GEZEL_HF_CACHE_DIR: join(homedir(), '.cache', 'gezel-test-hf'),
    },
  },
});
