import type { ResolvedModelProfile } from '../../model-profile/types.js';
import type { McpServerSpec } from '../mcp-spec.js';
import type { McpToolWrapper } from '../mcp-wrapper-types.js';
import { CraftbookSuggestionCompactor } from './craftbook-suggestion-compactor.js';
import { SourceWriteGuard } from './source-write-guard.js';
import { TaskStepArgNormalizer } from './task-step-arg-normalizer.js';
import { WorkspacePathNormalizer } from './workspace-path-normalizer.js';
import { ZodErrorTranslator } from './zod-error-translator.js';

export * from './craftbook-suggestion-compactor.js';
export * from './schema-shape-hint.js';
export * from './source-write-guard.js';
export * from './task-step-arg-normalizer.js';
export * from './workspace-path-normalizer.js';
export * from './zod-error-translator.js';

/**
 * The wrappers every host applies to gezel's own tools, in the daemon's
 * order. The daemon interleaves its Playwright and storage wrappers after
 * these (providers/mcp-wrappers/index.ts); a phone has neither.
 */
export const GEZEL_TOOL_WRAPPERS = [
  WorkspacePathNormalizer,
  TaskStepArgNormalizer,
  SourceWriteGuard,
  ZodErrorTranslator,
  CraftbookSuggestionCompactor,
] as const;

/**
 * The MCP wrappers a model profile contributes for one server, in profile
 * order. Each `Behavior.mcpWrapper` is a wrapper or a `(config) => wrapper`
 * factory; the wrapper's own `matches(spec)` still decides whether it applies.
 */
export function behaviorWrappersFor(
  profile: Pick<ResolvedModelProfile, 'behaviors'> | undefined,
  spec: McpServerSpec,
): McpToolWrapper[] {
  if (!profile) return [];
  const out: McpToolWrapper[] = [];
  for (const entry of profile.behaviors) {
    const w = entry.behavior.mcpWrapper;
    if (!w) continue;
    const wrapper = typeof w === 'function' ? w(entry.config) : w;
    let applies = true;
    try {
      applies = wrapper.matches(spec);
    } catch {
      applies = false;
    }
    if (applies) out.push(wrapper);
  }
  return out;
}
