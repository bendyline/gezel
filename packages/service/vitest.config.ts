import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * A flat worker cap tuned on an 18-core workstation is 2x oversubscription
 * on a 4-vCPU GitHub runner, which starved fixed test timeouts badly enough
 * to redden eight consecutive main builds in July 2026 (a different test
 * each time). Scale to the host instead, and never drop below 2.
 */
const MAX_WORKERS = Math.max(2, Math.min(8, availableParallelism()));

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
  'src/legacy-full-ui.integration.test.ts',
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
  // WebAssembly grammar compilation has a high native-memory peak.
  'src/index-store/content-indexer.test.ts',
  // Script runner sandbox spawns + nested runs.
  'src/scripts/*.test.ts',
  'src/workspace/derive.test.ts',
  'src/tasks/manager-scripts.test.ts',
  'src/gezels/ensure.test.ts',
];

/**
 * Three times in five days (2026-07-22, -25, -26) a fork died with "Worker
 * exited unexpectedly" AFTER its own tests had passed. All three macOS crash
 * reports have the same shape: the main thread is inside node:sqlite
 * committing the content index (vec0.dylib loaded, no ONNX anywhere), while a
 * V8Worker thread aborts with a fatal OOM in `Zone::Expand` under
 * `ExecuteTurboshaftWasmCompilation` — V8 optimizing a hot web-tree-sitter
 * grammar in the background. Grammar wasm has enormous single functions (the
 * generated parse tables), and one Turboshaft compilation zone for them can
 * outgrow what the allocator hands back under full-suite pressure. Liftoff,
 * the baseline tier, never builds that graph, and grammar parse speed is
 * irrelevant to tests — so pin wasm to baseline in workers. Production keeps
 * tier-up.
 *
 * `--no-wasm-tier-up` alone is not enough under full-suite pressure: Liftoff's
 * initial grammar compilation still defaults to as many as 128 parallel V8
 * compilation tasks per worker. That reproduced the same native Zone OOM on a
 * 4-vCPU Linux runner on 2026-07-30, with content-indexer.test.ts as the only
 * file whose fork vanished. Compile one WASM function at a time in tests to
 * bound that native-memory spike.
 *
 * Neither flag stopped it: the same file's fork vanished again on 2026-07-31,
 * and "Fatal process out of memory: Zone" is what V8 reports when a zone
 * segment `malloc` returns null — i.e. the whole runner is out of memory, and
 * the wasm compiler is merely the process making the largest single request.
 * Node sizes its default old-space from total RAM (GBs per fork on a 16 GB
 * runner), so several forks holding uncollected garbage can starve everyone.
 * Cap the JS heap instead: no service test needs a gigabyte, and a bounded
 * ceiling per fork keeps headroom for the native allocations that die first.
 *
 * Guarded by src/test-pool.test.ts. Vitest 4 removed `poolOptions` — these are
 * top-level `execArgv`, set per project because root-level values do not reach
 * the workers.
 */
const WORKER_EXEC_ARGV = [
  '--no-wasm-tier-up',
  '--wasm-num-compilation-tasks=1',
  '--max-old-space-size=1024',
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
    maxWorkers: MAX_WORKERS,
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
          execArgv: WORKER_EXEC_ARGV,
          // Keep integration files sequential while retaining the shared
          // project-level worker cap required for parallel project groups.
          fileParallelism: false,
          // The default 5s budget — and the previous 10s override — are below
          // the full-suite tail for real service/git subprocess work even
          // though the tests pass alone. Hooks need the same headroom because
          // ChatManager teardown drains background turns before removing its
          // temporary home.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: INTEGRATION_SUITES,
          pool: 'forks',
          execArgv: WORKER_EXEC_ARGV,
          // Bound unit + integration workers to avoid oversubscribing hosts.
          maxWorkers: MAX_WORKERS,
        },
      },
    ],
  },
});
