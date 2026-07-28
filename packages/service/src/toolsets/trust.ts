import type { ToolsetRuntime } from '@bendyline/gezel';

/**
 * First-party local toolsets whose runtime enforces its own narrow authority.
 *
 * DocBlocks receives explicit read/write roots at spawn time and has no
 * service credential. It is therefore safe to run under the strict presets
 * once its exact bundled manifest has been sha256-verified, unlike arbitrary
 * third-party MCP servers that can access the host directly.
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
    runtime.entry === 'dist/index.js' &&
    runtime.args.length === 1 &&
    runtime.args[0] === 'mcp' &&
    /^[a-f0-9]{64}$/i.test(runtime.sha256)
  );
}
