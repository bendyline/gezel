/**
 * Spec-shape helper for the gezel-mcp bridge. Detects whether a given
 * {@link McpServerSpec} launches our own gezel-mcp server (vs. a
 * third-party MCP like `@playwright/mcp`). Used by the model-profile
 * behaviors that target gezel-mcp specifically — `mcp.relax-required-
 * fields`, `mcp.default-missing-fields`, `mcp.validate-ids-strict`,
 * `turn.single-tool-per-turn` — to gate their `matches(spec)`
 * predicates.
 *
 * The legacy `GezelMcpSmallModelRelaxer` wrapper that previously lived
 * in this file has been split into the two profile-driven behaviors
 * above; only the spec-detection helper survives, kept here so the
 * existing import paths keep working without churn.
 */
import type { McpServerSpec } from '../mcp-bridge.js';

export function isGezelMcp(spec: McpServerSpec): boolean {
  // gezel-mcp only ever runs as a stdio subprocess we spawn ourselves —
  // a hosted (http-mcp) entry from the upstream registry can't be it,
  // so short-circuit on the discriminator before the haystack check.
  if (spec.kind === 'http') return false;
  const haystack = [spec.command, ...spec.args].join(' ');
  // Two flavors of launch path land here, both run as `node <path>`:
  //
  //   - **Packaged install:** the path includes the npm package name,
  //     e.g. `…/node_modules/@bendyline/gezel-mcp/dist/server.js`.
  //   - **Dev / workspace:** `require.resolve('@bendyline/gezel-mcp/dist/server.js')`
  //     returns the actual file path, which in our pnpm workspace is
  //     `<repo>/packages/mcp/dist/server.js`. The package-name string
  //     never appears.
  //
  // Match either. The substring `gezel-mcp` alone would be a false-
  // positive trap (any path containing that bare token would match);
  // the tighter regex below is bounded to the canonical dist/server.js
  // shape we know we ship.
  return (
    haystack.includes('@bendyline/gezel-mcp') ||
    /[/\\]packages[/\\]mcp[/\\]dist[/\\]server\.js\b/.test(haystack)
  );
}
