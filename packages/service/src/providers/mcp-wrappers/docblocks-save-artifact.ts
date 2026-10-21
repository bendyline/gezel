/**
 * DocBlocks MCP — keep `save_artifact` on the one folder it may write, and
 * make each refusal say how to succeed.
 *
 * Gezel grants DocBlocks exactly one write root, the project's artifacts
 * drawer (ChatManager's docblocks spawn args), yet three things a model does
 * routinely made the real tool refuse (qwen3.8-27b, 2026-10-21):
 *
 *  - it names the root by a word it made up (`"rootId": "project-artifacts"`)
 *    and gets "Unknown or unwritable MCP root";
 *  - it saves into a folder that does not exist yet and gets "MCP output
 *    parent directory does not exist";
 *  - after a gate sends the step back, it re-saves the same path, gets "MCP
 *    output already exists", then passes the NEW artifact's sha256 as
 *    `expectedSha256` and gets "hash precondition failed" — twice per pass.
 *
 * With one write root there is nothing to guess, so the root is filled in
 * and the parent folders created. The replace precondition stays the
 * model's decision; the refusal now carries the sha256 of the file it would
 * replace. DocBlocks materializes files itself, so the drawer's reserved
 * folders are refused here exactly as the artifact store refuses them.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import {
  gezelArtifactWriteDenial,
  normalizeArtifactPath,
} from '../../fs/project-artifacts-store.js';
import {
  allowedDirs,
  docblocksRootId,
  isDocblocksMcp,
  isRootRelativePath,
} from './docblocks-root-resolver.js';
import type { McpPreProcessVerdict, McpToolWrapper, McpToolWrapperContext } from './types.js';

interface ListedRoot {
  label: string;
  write: boolean;
}

interface SaveRoots {
  /** The single write root, when DocBlocks confirms exactly one. */
  write: { id: string; label: string; physical: string } | null;
  listed: Map<string, ListedRoot>;
}

const saveRootTables = new WeakMap<McpToolWrapperContext, Promise<SaveRoots>>();

function listedRoots(text: string): Map<string, ListedRoot> {
  const listed = new Map<string, ListedRoot>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return listed;
  }
  const record = parsed as { roots?: unknown; result?: { roots?: unknown } } | null;
  const roots = record?.roots ?? record?.result?.roots;
  if (!Array.isArray(roots)) return listed;
  for (const root of roots as Array<{ id?: unknown; label?: unknown; write?: unknown }>) {
    if (typeof root.id !== 'string') continue;
    listed.set(root.id, {
      label: typeof root.label === 'string' ? root.label : root.id,
      write: root.write === true,
    });
  }
  return listed;
}

async function loadSaveRoots(ctx: McpToolWrapperContext): Promise<SaveRoots> {
  const dirs = 'args' in ctx.spec ? allowedDirs(ctx.spec.args, '--allow-write') : [];
  const listed = listedRoots((await ctx.callTool('list_roots', {})).text);
  if (dirs.length !== 1) return { write: null, listed };
  const physical = await realpath(resolve(dirs[0]!)).catch(() => null);
  if (!physical) return { write: null, listed };
  const id = docblocksRootId(physical);
  const root = listed.get(id);
  // Trust the derived id only when DocBlocks lists it as writable.
  return { write: root?.write ? { id, label: root.label, physical } : null, listed };
}

function saveRootsFor(ctx: McpToolWrapperContext): Promise<SaveRoots> {
  let table = saveRootTables.get(ctx);
  if (!table) {
    table = loadSaveRoots(ctx).catch(() => {
      saveRootTables.delete(ctx);
      return { write: null, listed: new Map() };
    });
    saveRootTables.set(ctx, table);
  }
  return table;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The destination object, also when a model sent it as a JSON string. */
function destinationOf(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function sha256Of(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}

export const DocblocksSaveArtifact: McpToolWrapper = {
  id: 'docblocks-save-artifact',
  matches: isDocblocksMcp,
  async preProcess(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    if (toolName !== 'save_artifact') return { kind: 'allow' };
    const destination = destinationOf(args.destination);
    if (!destination) return { kind: 'allow' };
    const { write, listed } = await saveRootsFor(ctx);
    if (!write) return { kind: 'allow' };

    const rootId = destination.rootId;
    const named = typeof rootId === 'string' ? listed.get(rootId) : undefined;
    if (named && !named.write) {
      return {
        kind: 'reject',
        error: `The ${named.label} folder is read-only for DocBlocks. Save into the ${write.label} folder instead: destination.rootId "${write.id}".`,
      };
    }

    const next: Record<string, unknown> = { ...destination, rootId: write.id };
    if (typeof destination.path === 'string') {
      const path = normalizeArtifactPath(destination.path.trim());
      if (!isRootRelativePath(path)) return { kind: 'allow', args: { ...args, destination: next } };
      const denial = gezelArtifactWriteDenial(path);
      if (denial) {
        return {
          kind: 'reject',
          error: `DocBlocks cannot save to "${path}": ${denial}. Choose another path in the ${write.label} folder.`,
        };
      }
      next.path = path;
      const parent = dirname(path);
      const physicalParent = parent === '.' ? null : safeJoin(write.physical, parent);
      if (physicalParent) await mkdir(physicalParent, { recursive: true }).catch(() => {});
    }
    return { kind: 'allow', args: { ...args, destination: next } };
  },

  async postProcessError(
    toolName: string,
    args: Record<string, unknown>,
    errorText: string,
    ctx: McpToolWrapperContext,
  ): Promise<string> {
    if (toolName !== 'save_artifact') return errorText;
    if (!/MCP output already exists|hash precondition failed/i.test(errorText)) return errorText;
    const destination = destinationOf(args.destination);
    const { write } = await saveRootsFor(ctx);
    if (!write || typeof destination?.path !== 'string') return errorText;
    const path = normalizeArtifactPath(destination.path.trim());
    const physical = isRootRelativePath(path) ? safeJoin(write.physical, path) : null;
    const sha = physical ? await sha256Of(physical) : null;
    if (!sha) return errorText;
    return `${errorText}\n\n"${path}" already exists in the ${write.label} folder; its sha256 is ${sha}. To overwrite it, call save_artifact again with destination.ifExists "replace" and destination.expectedSha256 "${sha}" (the file being replaced, not the new artifact). Or save under a new file name.`;
  },
};
