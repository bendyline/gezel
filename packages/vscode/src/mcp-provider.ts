import type { GezelClient } from '@bendyline/gezel-client/node';
import * as vscode from 'vscode';
import type { createLogger } from './log.js';

/**
 * Gezel's tools for VS Code's own agent mode: the extension tells VS Code to
 * start `gezel-mcp --harness vscode` for the project it already resolved for
 * the open folder. Feature-detected, so an older VS Code without MCP server
 * providers simply skips it.
 */

export const GEZEL_TOOLS_PROVIDER_ID = 'gezel.tools';

export interface GezelToolsProvider {
  /** The folder's project or the connection changed; VS Code asks again. */
  refresh(): void;
  dispose(): void;
}

export function registerGezelToolsProvider(opts: {
  getClient: () => GezelClient | null;
  getProjectId: () => string | null;
  version: string;
  logger: ReturnType<typeof createLogger>;
}): GezelToolsProvider | null {
  if (
    typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function' ||
    typeof vscode.McpStdioServerDefinition !== 'function'
  ) {
    opts.logger.info('mcp-provider: this VS Code has no MCP server providers; skipping');
    return null;
  }
  const changed = new vscode.EventEmitter<void>();
  const registration = vscode.lm.registerMcpServerDefinitionProvider(GEZEL_TOOLS_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: async () => {
      const client = opts.getClient();
      if (!client) return [];
      try {
        const spec = await client.getHarnessLaunchSpec('vscode', opts.getProjectId() ?? undefined);
        return [
          new vscode.McpStdioServerDefinition('Gezel', spec.command, spec.args, {}, opts.version),
        ];
      } catch (err) {
        opts.logger.warn(
          `mcp-provider: no launch command from Gezel: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  });
  return {
    refresh: () => changed.fire(),
    dispose: () => {
      registration.dispose();
      changed.dispose();
    },
  };
}
