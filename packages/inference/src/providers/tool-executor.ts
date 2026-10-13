import type { LocalToolExecutor, LocalToolOutputBudget } from '@bendyline/gezel/local-loop';
import type { SessionOpts } from './types.js';
export interface ToolExecutor extends LocalToolExecutor {
  hasCallableRestriction(): boolean;
  isRestrictedFromCalling(name: string): boolean;
  callToolRich(
    name: string,
    args: Record<string, unknown>,
    options?: LocalToolOutputBudget,
  ): Promise<{ text: string; isError: boolean }>;
}
export type ToolExecutorFactory = (
  options: SessionOpts,
  logPrefix: string,
) => Promise<ToolExecutor>;
export async function createToolExecutor(
  options: SessionOpts,
  logPrefix: string,
): Promise<ToolExecutor> {
  if (options.toolExecutorFactory) return options.toolExecutorFactory(options, logPrefix);
  if (options.mcpServer || options.extraMcpServers?.length)
    throw new Error('MCP tools require a host tool executor');
  return {
    isEmpty: () => true,
    getOpenAITools: () => [],
    hasTool: () => false,
    hasCallableRestriction: () => false,
    isRestrictedFromCalling: () => false,
    callTool: async () => {
      throw new Error('No host tools are installed');
    },
    callToolRich: async () => {
      throw new Error('No host tools are installed');
    },
    stop: async () => {},
  };
}
