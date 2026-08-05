import type { ToolsetRuntime } from './schemas/catalog.js';

/**
 * First-party local toolsets whose runtime enforces its own narrow authority.
 *
 * Keep this predicate in core so every launch surface (service routes, chat
 * orchestration, and future clients) applies the same exact provenance check.
 * A matching id alone is never enough: the bundled source, package, supported
 * published entrypoint, argv, and pinned archive hash all have to match.
 */
export function isTrustedConstrainedToolset(args: {
  toolsetId: string;
  sourceId: string;
  runtime: ToolsetRuntime;
}): boolean {
  const { toolsetId, sourceId, runtime } = args;
  return (
    sourceId === 'bundled' &&
    toolsetId === 'docblocks' &&
    runtime.kind === 'npm-package' &&
    runtime.package === '@bendyline/docblocks-cli' &&
    (runtime.entry === 'dist/bin.js' || runtime.entry === 'dist/index.js') &&
    runtime.args.length === 1 &&
    runtime.args[0] === 'mcp' &&
    /^[a-f0-9]{64}$/i.test(runtime.sha256)
  );
}
