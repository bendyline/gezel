import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * A large slice of the service tests stand up a real moving part: an
 * embedded HTTP service, a ChatManager driving the mock provider, the MCP
 * bridge, git child processes, or a script sandbox. Keep those files in a
 * single integration worker so their subprocess trees do not compete with
 * one another. Everything else remains parallel, with a bounded worker pool.
 */
const INTEGRATION_SUITES = [
  // Full embedded-service / HTTPS boots.
  'src/integration.test.ts',
  'src/https-integration.test.ts',
  'src/sessions-integration.test.ts',
  // ChatManager-driven suites (mock provider + MCP bridge subprocess).
  'src/chat/keurmeester-intervention.test.ts',
  'src/chat/manager*.test.ts',
  'src/chat/prefix-layering.test.ts',
  'src/chat/questions.test.ts',
  // HTTP route suites stand up a Hono app + service context.
  'src/http/routes/**/*.test.ts',
  // Real git subprocesses, shared clones, and worktrees.
  'src/github/manager*.test.ts',
  // Node MCP subprocesses / external runtimes.
  'src/providers/mcp-bridge.test.ts',
  'src/providers/llama-cpp/provider.test.ts',
  'src/providers/native/capacity-broker.test.ts',
  // Script runner sandbox spawns + nested runs.
  'src/scripts/*.test.ts',
  'src/workspace/derive.test.ts',
  'src/tasks/manager-scripts.test.ts',
  'src/gezels/ensure.test.ts',
];

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
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: INTEGRATION_SUITES,
          pool: 'forks',
          // Keep integration files sequential while retaining the shared
          // project-level worker cap required for parallel project groups.
          fileParallelism: false,
          // The default 5s budget is below the full-suite tail for real
          // service/git subprocess work even though the tests pass alone.
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: INTEGRATION_SUITES,
          pool: 'forks',
          // Bound unit + integration workers to avoid oversubscribing hosts.
          maxWorkers: 8,
        },
      },
    ],
  },
});
