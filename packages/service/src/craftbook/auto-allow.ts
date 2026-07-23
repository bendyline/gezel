import type { CraftbookToolsetNeed, HookSpec } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';

/**
 * The single source of truth for "which tools does a craftbook
 * pre-authorize." Both the in-process hook path (a synthesized
 * PreToolUse allow-hook on the MCP bridge) and the Claude-CLI permission
 * broker (`/api/permissions/request-and-wait`) derive their auto-allow
 * set from here, so a tool is treated identically on either path.
 *
 * For each declared toolset with `autoAllow: true`, we resolve its
 * catalog manifest and union the names of every tool it exposes
 * (`ToolsetManifest.tools[]`). Toolsets without `autoAllow` — and tools
 * not belonging to a declared toolset — are left to the normal gating
 * path.
 */
export async function autoAllowedToolsForToolsets(
  catalog: CatalogService,
  toolsets: CraftbookToolsetNeed[] | undefined,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const need of toolsets ?? []) {
    if (!need.autoAllow) continue;
    const detail = await catalog
      .get('toolset', need.toolsetId, need.sourceId, need.minVersion)
      .catch(() => null);
    if (!detail || detail.manifest.kind !== 'toolset') continue;
    for (const tool of detail.manifest.tools ?? []) out.add(tool.name);
  }
  return out;
}

/** Escape a string for safe interpolation into a RegExp character-by-character. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a static-decision PreToolUse hook that auto-allows exactly the
 * given tool names, or `null` when the set is empty. The matcher is an
 * anchored alternation of the (regex-escaped) names so it never
 * accidentally matches a tool the craftbook didn't declare. The hook
 * carries no `script` — it relies on `HookSpec.decision`, which
 * `evaluateHooks` honors without a script runner.
 */
export function buildAutoAllowHook(
  toolNames: ReadonlySet<string>,
  craftbookId: string,
): HookSpec | null {
  if (toolNames.size === 0) return null;
  const alternation = [...toolNames].map(escapeRegExp).join('|');
  return {
    phase: 'PreToolUse',
    matcher: `^(?:${alternation})$`,
    decision: 'allow',
    label: `auto-allowed by ${craftbookId}`,
  };
}
