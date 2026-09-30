/**
 * DocBlocks MCP — fill in the read root a document source left out.
 *
 * Gezel grants DocBlocks two read roots, the project workspace and the
 * artifacts drawer (ChatManager's docblocks spawn args). DocBlocks refuses a
 * root-relative path that does not name one ("Ambiguous MCP root") rather
 * than guess, and the names are opaque ids a model has to copy out of
 * `list_roots`. It often doesn't, even straight after calling it: a
 * gemma4-26b reviewer listed the roots, then sent `inspect_document` a bare
 * `powerpoint/task-13/deck.pptx` (default/13, 2026-09-30).
 *
 * The runtime can answer that without guessing: when the path names a file
 * under exactly one granted root, that root is the only one the call could
 * mean. A path found under several roots, or under none, is refused here with
 * the folders named — DocBlocks' own reply to a missing file ("outside the
 * selected root") sends a model hunting for a permission problem.
 *
 * Root ids are recomputed the way DocBlocks derives them and trusted only
 * when `list_roots` returns them, so a DocBlocks release that changes the
 * derivation falls back to today's behavior instead of naming a wrong root.
 */
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPathInside, safeJoin } from '../../fs/safe-paths.js';
import type { McpServerSpec } from '../mcp-bridge.js';
import type { McpPreProcessVerdict, McpToolWrapper, McpToolWrapperContext } from './types.js';

/** Arguments DocBlocks parses as a document source, per tool. `create_document_bundle` takes a bundle, not a file. */
const DOCUMENT_SOURCE_ARGS: Readonly<Record<string, readonly string[]>> = {
  apply_inferred_theme: ['source', 'themeSource'],
  compare_documents: ['left', 'right'],
  convert_document: ['source'],
  describe_theme: ['source'],
  get_authoring_context: ['source'],
  infer_theme_from_file: ['source'],
  inspect_document: ['source'],
  inspect_pptx_layouts: ['source'],
  preview_document: ['source'],
  recommend_templates: ['source'],
};

interface ReadRoot {
  id: string;
  label: string;
  physical: string;
}

const readRootTables = new WeakMap<McpToolWrapperContext, Promise<ReadRoot[]>>();

function isDocblocksMcp(spec: McpServerSpec): boolean {
  return spec.toolsetId === 'docblocks';
}

/** DocBlocks' `rootIdFor`: a hash of the root's real path, case-folded on Windows. */
export function docblocksRootId(physicalPath: string, platform = process.platform): string {
  const normalized = platform === 'win32' ? physicalPath.toLowerCase() : physicalPath;
  return `root-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

/** Directories granted by `--allow-read`, a commander variadic option. */
export function allowReadDirs(args: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--allow-read=')) {
      dirs.push(arg.slice('--allow-read='.length));
      continue;
    }
    if (arg !== '--allow-read') continue;
    while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) dirs.push(args[++i]!);
  }
  return dirs;
}

function listedReadRoots(text: string): Map<string, string> {
  const listed = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return listed;
  }
  const record = parsed as { roots?: unknown; result?: { roots?: unknown } } | null;
  const roots = record?.roots ?? record?.result?.roots;
  if (!Array.isArray(roots)) return listed;
  for (const root of roots as Array<{ id?: unknown; label?: unknown; read?: unknown }>) {
    if (typeof root.id === 'string' && root.read === true) {
      listed.set(root.id, typeof root.label === 'string' ? root.label : root.id);
    }
  }
  return listed;
}

async function loadReadRoots(ctx: McpToolWrapperContext): Promise<ReadRoot[]> {
  const dirs = 'args' in ctx.spec ? allowReadDirs(ctx.spec.args) : [];
  // With one root DocBlocks resolves an omitted id itself.
  if (dirs.length < 2) return [];
  const listed = listedReadRoots((await ctx.callTool('list_roots', {})).text);
  const roots: ReadRoot[] = [];
  for (const dir of dirs) {
    const physical = await realpath(resolve(dir)).catch(() => null);
    if (!physical) continue;
    const id = docblocksRootId(physical);
    const label = listed.get(id);
    if (label !== undefined && !roots.some((root) => root.id === id)) {
      roots.push({ id, label, physical });
    }
  }
  return roots;
}

function readRootsFor(ctx: McpToolWrapperContext): Promise<ReadRoot[]> {
  let table = readRootTables.get(ctx);
  if (!table) {
    table = loadReadRoots(ctx).catch(() => {
      readRootTables.delete(ctx);
      return [];
    });
    readRootTables.set(ctx, table);
  }
  return table;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file source's object form, when it names a path but no root. Flat strings are DocBlocks' shorthand for the same thing. */
function unrootedFileSource(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{')) {
      try {
        return unrootedFileSource(JSON.parse(text));
      } catch {
        return null;
      }
    }
    if (text.startsWith('docblocks://')) return null;
    return { kind: 'file', path: text };
  }
  if (
    isRecord(value) &&
    value.kind === 'file' &&
    typeof value.path === 'string' &&
    (value.rootId === undefined || value.rootId === null)
  ) {
    return value;
  }
  return null;
}

/** DocBlocks' root-relative grammar. Anything else is left for DocBlocks to reject in its own words. */
function isRootRelativePath(path: string): boolean {
  if (!path || path.length > 4096 || path.includes('\\') || path.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        ![...segment].some((ch) => (ch.codePointAt(0) ?? 0) <= 31),
    );
}

async function holdsFile(root: ReadRoot, path: string): Promise<boolean> {
  const candidate = safeJoin(root.physical, path);
  if (!candidate) return false;
  const physical = await realpath(candidate).catch(() => null);
  if (!physical || !isPathInside(physical, root.physical)) return false;
  return (await stat(physical).catch(() => null))?.isFile() === true;
}

export const DocblocksRootResolver: McpToolWrapper = {
  id: 'docblocks-root-resolver',
  matches: isDocblocksMcp,
  async preProcess(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    const keys = (DOCUMENT_SOURCE_ARGS[toolName] ?? []).filter(
      (key) => unrootedFileSource(args[key]) !== null,
    );
    if (keys.length === 0) return { kind: 'allow' };
    const roots = await readRootsFor(ctx);
    if (roots.length < 2) return { kind: 'allow' };

    const next = { ...args };
    for (const key of keys) {
      const source = unrootedFileSource(args[key])!;
      const path = source.path as string;
      if (!isRootRelativePath(path)) continue;
      const hits: ReadRoot[] = [];
      for (const root of roots) {
        if (await holdsFile(root, path)) hits.push(root);
      }
      if (hits.length === 1) {
        next[key] = { ...source, rootId: hits[0]!.id };
        continue;
      }
      const folders = roots.map((root) => root.label).join(', ');
      if (hits.length === 0) {
        return {
          kind: 'reject',
          error: `No file "${path}" exists in the folders DocBlocks can read (${folders}). The path is relative to one of those folders; check it before retrying.`,
        };
      }
      return {
        kind: 'reject',
        error: `"${path}" exists in more than one folder DocBlocks can read: ${hits
          .map((root) => `${root.label} (rootId "${root.id}")`)
          .join(', ')}. Pass the rootId of the one you mean in ${key}.`,
      };
    }
    return { kind: 'allow', args: next };
  },
};
