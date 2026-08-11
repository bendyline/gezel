import type { McpServerSpec } from '../mcp-bridge.js';
import { isGezelMcp } from './gezel-mcp-small-model.js';
import type { McpToolWrapper } from './types.js';

/**
 * Gezel's workspace tools already resolve paths relative to the project
 * workspace root. Local models still occasionally copy the UI/storage label
 * from a prompt and call `write_file({ path: "workspace/index.html" })`, which
 * otherwise creates `workspace/workspace/index.html`. Strip that one
 * redundant leading label at the bridge boundary so reads, writes, and edits
 * all agree on the same shipping path.
 */
export function normalizeWorkspaceToolPath(path: string): string {
  return path.replace(/^(?:\.\/)?workspace[\\/]+/i, '');
}

const PATH_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  list_dir: ['path'],
  read_file: ['path'],
  stat: ['path'],
  write_file: ['path'],
  append_to_file: ['path'],
  replace_in_file: ['path'],
  replace_lines: ['path'],
  apply_patch: ['path'],
  insert_at_marker: ['path'],
  delete_path: ['path'],
  make_dir: ['path'],
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
    if (toolName === 'read_files') {
      let changed = false;
      const nextArgs = { ...args };
      if (Array.isArray(args.files)) {
        nextArgs.files = args.files.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const record = item as Record<string, unknown>;
          if (typeof record.path !== 'string') return item;
          const path = normalizeWorkspaceToolPath(record.path);
          if (path === record.path || path.length === 0) return item;
          changed = true;
          return { ...record, path };
        });
      }
      if (Array.isArray(args.paths)) {
        nextArgs.paths = args.paths.map((item) => {
          if (typeof item !== 'string') return item;
          const path = normalizeWorkspaceToolPath(item);
          if (path === item || path.length === 0) return item;
          changed = true;
          return path;
        });
      }
      return changed ? { kind: 'allow', args: nextArgs } : { kind: 'allow' };
    }

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
