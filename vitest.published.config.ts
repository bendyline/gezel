/**
 * Separate config for the published-package contract suite at
 * `tests/published/`.
 *
 * These tests run against the built `packages/<pkg>/dist` artifacts and
 * against `npm pack` / `pnpm pack` output — not against `src/`. They catch
 * publishing-shape bugs the per-package vitest suites cannot see: a
 * `workspace:*` range leaking into a tarball, a missing `exports` target
 * that only fails at `require.resolve` time, source maps bloating the
 * payload, a placeholder native-release pin.
 *
 * Run after `pnpm build`:
 *   pnpm test:published
 *
 * The per-package configs never pick these up, so `pnpm test` stays fast
 * and source-only.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/published/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Packing the service tarball is a real ~20 MB tar; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
