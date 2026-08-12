import { isGezelMcp } from './gezel-mcp-small-model.js';
import type { McpToolResult, McpToolWrapper } from './types.js';

const NEXT_CALL_RE = /invoke_craftbook\(\{\s*craftbookId:\s*"([^"]+)"\s*\}\)/;
const FIRST_MATCH_RE =
  /^1\.\s+(.+?)\s+\(id:\s*([^)]+)\)\s+\[[^\]]*?(\d+)% match\](?:\s+\[SETUP REQUIRED:\s*([^\]]+)\])?/m;

interface CompactCraftbookRecommendation {
  recommendedCraftbook: {
    id: string;
    name?: string;
    matchPercent?: number;
    setupRequired?: string[];
  };
  nextCall: {
    tool: 'invoke_craftbook';
    arguments: { craftbookId: string };
  };
  instruction: string;
}

/**
 * Reduce the ranked five-item shortlist to the single transition a compact
 * model needs. The full result remains available to stronger tiers.
 */
export function compactCraftbookSuggestion(text: string): string | null {
  const nextCall = NEXT_CALL_RE.exec(text);
  if (!nextCall?.[1]) return null;

  const craftbookId = nextCall[1];
  const firstMatch = FIRST_MATCH_RE.exec(text);
  const recommendation: CompactCraftbookRecommendation = {
    recommendedCraftbook: {
      id: craftbookId,
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
      arguments: { craftbookId },
    },
    instruction:
      'Call invoke_craftbook now. It will install trusted zero-configuration dependencies or report any remaining setup. Do not call suggest_craftbook again.',
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
