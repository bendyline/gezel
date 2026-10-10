import { isGezelMcp } from '../gezel-mcp.js';
import type { McpToolResult, McpToolWrapper } from '../mcp-wrapper-types.js';

const NEXT_CALL_JSON_RE = /invoke_craftbook\((\{[^\n]+\})\)/;
const NEXT_CALL_LEGACY_RE = /invoke_craftbook\(\{\s*craftbookId:\s*"([^"]+)"\s*\}\)/;
const FIRST_MATCH_RE =
  /^1\.\s+(.+?)\s+\(id:\s*([^)]+)\)\s+\[[^\]]*?(\d+)% match\](?:[^\S\n]+\[SETUP REQUIRED:\s*([^\]]+)\])?(?:[^\S\n]+—[^\S\n]+([^\n]+))?/m;

interface CompactCraftbookRecommendation {
  recommendedCraftbook: {
    id: string;
    name?: string;
    description?: string;
    matchPercent?: number;
    setupRequired?: string[];
  };
  nextCall: {
    tool: 'invoke_craftbook';
    arguments: Record<string, unknown> & { craftbookId: string };
  };
  instruction: string;
}

/**
 * Keep the leading candidate compact without turning a ranking into a mandate.
 * Its description is necessary for judging fit; otherwise retain the full result.
 */
export function compactCraftbookSuggestion(text: string): string | null {
  let nextArguments: (Record<string, unknown> & { craftbookId: string }) | null = null;
  const jsonCall = NEXT_CALL_JSON_RE.exec(text)?.[1];
  if (jsonCall) {
    try {
      const parsed = JSON.parse(jsonCall) as Record<string, unknown>;
      if (typeof parsed.craftbookId === 'string') {
        nextArguments = parsed as Record<string, unknown> & { craftbookId: string };
      }
    } catch {
      // Fall through to the legacy human-readable call below.
    }
  }
  const legacyCraftbookId = NEXT_CALL_LEGACY_RE.exec(text)?.[1];
  if (!nextArguments && legacyCraftbookId) nextArguments = { craftbookId: legacyCraftbookId };
  if (!nextArguments) return null;

  const craftbookId = nextArguments.craftbookId;
  const firstMatch = FIRST_MATCH_RE.exec(text);
  if (firstMatch?.[2] !== craftbookId || !firstMatch[5]) return null;
  const recommendation: CompactCraftbookRecommendation = {
    recommendedCraftbook: {
      id: craftbookId,
      description: firstMatch[5].trim(),
      ...(firstMatch?.[2] === craftbookId && firstMatch[1] ? { name: firstMatch[1].trim() } : {}),
      ...(firstMatch?.[2] === craftbookId && firstMatch[3]
        ? { matchPercent: Number.parseInt(firstMatch[3], 10) }
        : {}),
      ...(firstMatch?.[2] === craftbookId && firstMatch[4]
        ? {
            setupRequired: firstMatch[4]
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
    },
    nextCall: {
      tool: 'invoke_craftbook',
      arguments: nextArguments,
    },
    instruction:
      'Use only if the description fits. Reject an unsuitable match for a generic build-loop task. Preserve the full brief and project. For a new project, use start_project instead; otherwise pass its id explicitly. Dependencies may require setup.',
  };

  return JSON.stringify(recommendation);
}

export const CraftbookSuggestionCompactor: McpToolWrapper = {
  id: 'craftbook-suggestion-compactor',
  matches: isGezelMcp,

  async postProcess(toolName, _args, result, ctx): Promise<McpToolResult> {
    if (
      toolName !== 'suggest_craftbook' ||
      (ctx.modelTier !== 'tiny' && ctx.modelTier !== 'small')
    ) {
      return result;
    }

    const compacted = compactCraftbookSuggestion(result.text);
    return compacted ? { ...result, text: compacted } : result;
  },
};
