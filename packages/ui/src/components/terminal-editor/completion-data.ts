import type { WorkspaceCommandIndex } from '@bendyline/gezel';

/**
 * The completion provider (registered once, app-global, in
 * `terminal-monaco-setup.ts`) can't close over React state, so the React layer
 * writes the current per-project completion sources into this module-level
 * store keyed by the editor's model-URI string (which encodes the projectId),
 * and the provider reads them synchronously on each invocation. Per-URI keying
 * keeps multiple project terminals (tabs / remounts) from clobbering each other.
 */

/** A craftbook the terminal can launch — `command` is the typed token. */
export interface CraftbookCompletionSpec {
  id: string;
  command: string;
  name?: string;
  description?: string;
  /** squisq/JSON-Schema; top-level `properties` (in order) are the params. */
  paramSchema?: Record<string, unknown>;
}

/** An MCP tool the terminal can run — `parameters` is the JSON-Schema arg shape. */
export interface McpToolCompletionSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface TerminalCompletionData {
  index: WorkspaceCommandIndex | null;
  craftbooks: CraftbookCompletionSpec[];
  mcpTools: McpToolCompletionSpec[];
}

export const EMPTY_COMPLETION_DATA: TerminalCompletionData = {
  index: null,
  craftbooks: [],
  mcpTools: [],
};

const store = new Map<string, TerminalCompletionData>();

export function setTerminalCompletionData(uriKey: string, data: TerminalCompletionData): void {
  store.set(uriKey, data);
}

export function getTerminalCompletionData(uriKey: string): TerminalCompletionData {
  return store.get(uriKey) ?? EMPTY_COMPLETION_DATA;
}

export function clearTerminalCompletionData(uriKey: string): void {
  store.delete(uriKey);
}
