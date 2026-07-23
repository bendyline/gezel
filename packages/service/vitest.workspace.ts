import { defineWorkspace } from 'vitest/config';

/**
 * Two-project split so the heavy, service-booting suites don't race.
 *
 * A large slice of the service tests stand up a real moving part — an
 * embedded HTTP service, a `ChatManager` driving the mock provider, the
 * MCP bridge (which spawns a Node subprocess), or `git` child processes.
 * Run many of those at once and the machine oversubscribes: child
 * processes starve, streams stall, and the 5s per-test timeout trips —
 * non-deterministically, only under full-suite parallel load (every one
 * of them passes in isolation).
 *
 * The `integration` project gathers those suites and runs them in a
 * single fork, one file at a time (`singleFork`), so at most one embedded
 * service is live at any moment. The `unit` project keeps everything else
 * parallel — but capped (`maxForks`) so the two projects' pools don't
 * stack to 2× the cores and re-create the oversubscription this split is
 * meant to remove. The globs partition the tree (unit excludes the
 * integration set), so every file runs exactly once.
 */
const INTEGRATION_SUITES = [
  // Full embedded-service / HTTPS boots.
  'src/integration.test.ts',
  'src/https-integration.test.ts',
  'src/sessions-integration.test.ts',
  // ChatManager-driven suites (mock provider + MCP bridge subprocess).
  'src/chat/manager*.test.ts',
  'src/chat/questions.test.ts',
  // HTTP route suites stand up a Hono app + service context.
  'src/http/routes/**/*.test.ts',
  // git subprocess (shared clones + worktrees) — both the worktree manager
  // suite and the sync/changes suite spawn many real `git` children per test.
  'src/github/manager*.test.ts',
  // Spawn a Node MCP subprocess / external runtimes.
  'src/providers/mcp-bridge.test.ts',
  'src/providers/llama-cpp/provider.test.ts',
  'src/providers/native/capacity-broker.test.ts',
  // Script runner sandbox spawns + nested runs.
  'src/scripts/*.test.ts',
  'src/workspace/derive.test.ts',
  'src/tasks/manager-scripts.test.ts',
  'src/gezels/ensure.test.ts',
];

export default defineWorkspace([
  {
    test: {
      name: 'integration',
      include: INTEGRATION_SUITES,
      // One embedded service at a time: all integration files share a
      // single fork and run sequentially within it.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      // These suites intentionally boot services, spawn subprocesses, and
      // exercise serialized chat flows. The default 5s budget is below the
      // observed full-suite tail under load even though the same tests finish
      // in ~2s alone. Keep unit tests on Vitest's stricter default while still
      // failing genuinely stuck integration work promptly.
      testTimeout: 10_000,
    },
  },
  {
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      exclude: INTEGRATION_SUITES,
      // Parallel, but bounded so unit + the integration fork together
      // stay well under the core count (24 here) — the default would
      // size a full pool per project and oversubscribe the box.
      pool: 'forks',
      poolOptions: { forks: { maxForks: 8, minForks: 1 } },
    },
  },
]);
