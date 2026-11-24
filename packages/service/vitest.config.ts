import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * A flat worker cap tuned on an 18-core workstation is 2x oversubscription
 * on a 4-vCPU GitHub runner, which starved fixed test timeouts badly enough
 * to redden eight consecutive main builds in July 2026 (a different test
 * each time). Scale to the host instead, and never drop below 2.
 */
const MAX_WORKERS = Math.max(2, Math.min(8, availableParallelism()));

/**
 * The projects run one after another, not side by side: the unit files, then
 * the fs-events group, then the integration files, which Vitest runs last
 * because they are isolated with file parallelism off. On the 2026-11-23 CI
 * run the unit project finished at 542 s and the first integration file
 * started after it. Holding a worker back for the integration lane therefore
 * only left one of four vCPUs idle for the whole unit phase.
 */
const UNIT_WORKERS = MAX_WORKERS;

const PACKAGE_ROOT = import.meta.dirname;

/** Test files under a package-relative folder, as `src/...` paths. */
function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts'))
        out.push(relative(PACKAGE_ROOT, path).split(sep).join('/'));
    }
  };
  walk(join(PACKAGE_ROOT, dir));
  return out.sort();
}

/**
 * What puts a route or ChatManager suite in the serial lane: it boots a
 * service, builds a ChatManager (whose sessions start an MCP child), or starts
 * a process or server itself. The rest of those folders are pure tests that
 * sat in the single worker only because of a folder glob: 55 route files and
 * six `manager-*` files, each paying ~1.3 s of serial fork overhead.
 */
const STANDS_UP_PROCESSES =
  /\bstartService\(|\bnew ChatManager\(|\bspawn(?:Sync)?\(|\bexecFile(?:Sync)?\(|\bfork\(|\bMcpBridge|\bcreateServer\(/;

function standsUpProcesses(file: string): boolean {
  return STANDS_UP_PROCESSES.test(readFileSync(join(PACKAGE_ROOT, file), 'utf8'));
}

const ROUTE_SUITES = testFilesUnder('src/http/routes').filter(standsUpProcesses);
const MANAGER_SUITES = testFilesUnder('src/chat')
  .filter((file) => /^src\/chat\/manager[^/]*\.test\.ts$/.test(file))
  .filter(standsUpProcesses);

/**
 * Files in the git and script folders that start nothing. Their neighbours
 * run git or the script sandbox from inside the code under test, where no
 * reading of the test file can see it, so these are listed by hand after
 * reading each one; a new file in those folders runs serially until added.
 */
const PURE_IN_SERIAL_FOLDERS = new Set([
  'src/git/ai.test.ts',
  'src/git/changes.test.ts',
  'src/git/model-clone-policy.test.ts',
  'src/git/manager.clone-auth.test.ts',
  'src/scripts/sdk.test.ts',
  'src/scripts/dispatcher-contract.test.ts',
  'src/scripts/trust.test.ts',
  'src/scripts/source.test.ts',
  'src/scripts/runs.test.ts',
  'src/scripts/dispatcher.test.ts',
]);

const GIT_AND_SCRIPT_SUITES = [
  ...testFilesUnder('src/git').filter((file) => /^src\/git\/[^/]+\.test\.ts$/.test(file)),
  ...testFilesUnder('src/scripts').filter((file) => /^src\/scripts\/[^/]+\.test\.ts$/.test(file)),
].filter((file) => !PURE_IN_SERIAL_FOLDERS.has(file));

/**
 * A large slice of the service tests stand up a real moving part: an
 * embedded HTTP service, a ChatManager driving the mock provider, the MCP
 * bridge, git child processes, or a script sandbox. Keep those files in a
 * single integration worker so their subprocess trees do not compete with
 * one another. Everything else remains parallel, with a bounded worker pool.
 */
/**
 * Each file gets its own fork because the integration project is isolated and
 * has file parallelism disabled. Keep the large grammar compilations split
 * across files: loading TypeScript + Swift + Kotlin + Scala in one fork was
 * enough to exhaust V8's native compilation zone on a 16 GB CI runner even
 * with tier-up disabled and one compilation task at a time.
 */
const NATIVE_MEMORY_SUITES = [
  'src/index-store/content-indexer.test.ts',
  'src/index-store/symbols-swift.test.ts',
  'src/index-store/symbols-kotlin.test.ts',
  'src/index-store/symbols-scala.test.ts',
];

/**
 * The serial lane in two halves of similar length, so CI can run each on its
 * own runner (`--project integration-chat`, `--project integration`). The
 * chat half is the ChatManager suites (mock provider + MCP bridge child) and
 * the bridge itself.
 */
/**
 * Kept in the other half only to even out the two runners' time: the chat
 * half was ~15 min and the other ~11 by the 2026-11-23 timings. Each file has
 * its own fork either way. Rebalance from the `test-timings-*` CI artifacts.
 */
const BALANCED_INTO_OTHER_HALF = [
  'src/chat/manager-handoff-entry.test.ts',
  'src/providers/mcp-bridge.test.ts',
];

const CHAT_INTEGRATION_SUITES = [
  ...MANAGER_SUITES,
  'src/chat/keurmeester-intervention.test.ts',
  'src/chat/band-prefix-gating.test.ts',
  'src/chat/prefix-layering.test.ts',
  'src/chat/questions.test.ts',
  'src/chat/session-token-rotation.test.ts',
].filter((file) => !BALANCED_INTO_OTHER_HALF.includes(file));

const INTEGRATION_SUITES = [
  // Naming is the primary contract: new integration suites should enter the
  // serialized pool automatically instead of relying on this list being
  // updated by hand.
  'src/**/*.integration.test.ts',
  // Full embedded-service / HTTPS boots.
  'src/integration.test.ts',
  'src/https-integration.test.ts',
  'src/legacy-full-ui.integration.test.ts',
  'src/sessions-integration.test.ts',
  'src/service-runtime.test.ts',
  'src/web-ui-mode.test.ts',
  // Route suites that boot a service; see STANDS_UP_PROCESSES.
  ...ROUTE_SUITES,
  ...BALANCED_INTO_OTHER_HALF,
  // Service boots that sit outside the route directory.
  'src/http/machine-engine*.test.ts',
  'src/http/ollama-emulation.test.ts',
  // Real git subprocesses, shared clones, and worktrees; script runner
  // sandbox spawns and nested runs.
  ...GIT_AND_SCRIPT_SUITES,
  // WebAssembly grammar compilation has a high native-memory peak.
  ...NATIVE_MEMORY_SUITES,
  'src/workspace/derive.test.ts',
  // pnpm 11 installs into a folder with no node_modules before `pnpm run`, so
  // each approved run here is a sandboxed install plus a script: ~0.4 s warm,
  // past 5 s cold under the full suite (2026-11-11).
  'src/workspace/scripts.test.ts',
  'src/tasks/manager-scripts.test.ts',
  'src/gezels/ensure.test.ts',
];

/**
 * Suites that wait for the OS to report a real file change. While the rest of
 * the suite churns the temp folder, macOS FSEvents reported a write ~30 s
 * late, past these tests' windows (2026-11-08). They run in their own group
 * with nothing else from this suite beside them.
 */
const FS_EVENT_SUITES = ['src/workspace/watch-manager.test.ts', 'src/library-e2e.test.ts'];

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
 * irrelevant to tests — so pin wasm to baseline in workers. Production pins it
 * too, more strictly: see `WASM_BASELINE_FLAGS` in src/index-store/symbols.ts.
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
 * Tests construct temporary user homes, but production discovery intentionally
 * reaches outside those homes for installer-managed machine state. Without a
 * harness-level override, running the suite on a workstation with Gezel
 * installed mounts the real shared projects/gezels and connects to the live
 * machine broker. Use unique, deliberately unpopulated roots for this Vitest
 * invocation. Tests for the mounted/shared and split-service paths replace
 * these overrides with their own fixtures.
 */
const HOST_ISOLATION_ROOT = join(tmpdir(), `gezel-vitest-host-isolation-${process.pid}`);

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
      GEZEL_MACHINE_SHARED_HOME: join(HOST_ISOLATION_ROOT, 'shared'),
      GEZEL_SYSTEM_SERVICE_HOME: join(HOST_ISOLATION_ROOT, 'machine-engine'),
      GEZEL_NATIVE_CAPACITY_DIR: join(HOST_ISOLATION_ROOT, 'native-capacity'),
      // The local context floor is host-derived (64K, or 32K on a
      // memory-constrained machine — see minViableLocalContextTokens), and a
      // 16 GB CI runner IS such a machine. Pin it so context assertions mean
      // the same thing on a workstation and on the runner; the tests that
      // exercise the constrained floor set it themselves.
      GEZEL_MIN_CONTEXT_TOKENS: '65536',
      // Every test home is fresh; without this each one would be a new install
      // whose background indexing waits half an hour. The first-use tests
      // unset it themselves.
      GEZEL_DISABLE_FIRST_USE_GRACE: '1',
      // A test service that turns LAN serving on must not announce itself
      // over mDNS on the developer's network. lan-discovery.test.ts drives
      // the advertiser and browser directly over loopback.
      GEZEL_LAN_DISCOVERY: 'off',
    },
    projects: [
      ...(
        [
          // Each half runs on its own; a later group starts when the earlier
          // finishes, so locally there is still one integration file at a time.
          {
            name: 'integration-chat',
            include: CHAT_INTEGRATION_SUITES,
            exclude: [],
            groupOrder: 2,
          },
          {
            name: 'integration',
            include: INTEGRATION_SUITES,
            exclude: CHAT_INTEGRATION_SUITES,
            groupOrder: 3,
          },
        ] as const
      ).map((half) => ({
        extends: true,
        test: {
          name: half.name,
          include: [...half.include],
          exclude: [...half.exclude],
          pool: 'forks' as const,
          execArgv: WORKER_EXEC_ARGV,
          // Explicit because native grammar memory is released only when the
          // per-file fork exits; do not let a future default change reuse it.
          isolate: true,
          // Keep integration files sequential while retaining the shared
          // project-level worker cap required for parallel project groups.
          fileParallelism: false,
          sequence: { groupOrder: half.groupOrder },
          // The default 5s budget — and the previous 10s override — are below
          // the full-suite tail for real service/git subprocess work even
          // though the tests pass alone. Hooks need the same headroom because
          // ChatManager teardown drains background turns before removing its
          // temporary home.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      })),
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...CHAT_INTEGRATION_SUITES, ...INTEGRATION_SUITES, ...FS_EVENT_SUITES],
          pool: 'forks',
          execArgv: WORKER_EXEC_ARGV,
          maxWorkers: UNIT_WORKERS,
        },
      },
      {
        extends: true,
        test: {
          name: 'fs-events',
          include: FS_EVENT_SUITES,
          pool: 'forks',
          execArgv: WORKER_EXEC_ARGV,
          // Vitest runs groups one after another: the unit files (group 0),
          // then this one, then the two integration halves (groups 2 and 3).
          // One file at a time, so neither adds churn to the other's watcher.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
