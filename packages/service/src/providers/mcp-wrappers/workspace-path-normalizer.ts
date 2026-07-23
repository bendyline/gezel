import type { McpServerSpec } from '../mcp-bridge.js';
import { isGezelMcp } from './gezel-mcp-small-model.js';
import type { McpToolWrapper } from './types.js';

/**
 * Gezel's workspace tools already resolve paths relative to the project
 * workspace root. Local models still occasionally copy the UI/storage label
 * from a prompt and call `writeFile({ path: "workspace/index.html" })`, which
 * otherwise creates `workspace/workspace/index.html`. Strip that one
 * redundant leading label at the bridge boundary so reads, writes, and edits
 * all agree on the same shipping path.
 */
export function normalizeWorkspaceToolPath(path: string): string {
  return path.replace(/^(?:\.\/)?workspace[\\/]+/i, '');
}

const PATH_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  readdir: ['path'],
  readFile: ['path'],
  stat: ['path'],
  writeFile: ['path'],
  appendToFile: ['path'],
  replaceInFile: ['path'],
  replaceLines: ['path'],
  applyPatch: ['path'],
  insertAtMarker: ['path'],
  rm: ['path'],
  mkdir: ['path'],
  rename: ['fromPath', 'toPath'],
  run_nodejs_script: ['path'],
  derive_file: ['outputPath'],
  validate: ['path'],
  generate_image: ['saveAs'],
  generate_video: ['saveAs'],
};

export const WorkspacePathNormalizer: McpToolWrapper = {
  id: 'workspace-path-normalizer',
  matches(spec: McpServerSpec): boolean {
    return isGezelMcp(spec);
  },
  async preProcess(toolName, args) {
    const fields = PATH_FIELDS_BY_TOOL[toolName];
    if (!fields) return { kind: 'allow' };
    if (toolName === 'validate' && args.where === 'artifact') return { kind: 'allow' };

    let nextArgs: Record<string, unknown> | undefined;
    for (const field of fields) {
      const value = args[field];
      if (typeof value !== 'string') continue;
      const normalized = normalizeWorkspaceToolPath(value);
      if (normalized === value || normalized.length === 0) continue;
      nextArgs ??= { ...args };
      nextArgs[field] = normalized;
    }

    return nextArgs ? { kind: 'allow', args: nextArgs } : { kind: 'allow' };
  },
};
