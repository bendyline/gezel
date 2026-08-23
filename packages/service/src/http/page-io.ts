/**
 * The single implementation behind every page-bridge surface: the
 * first-party `/api/projects/:id/page-invoke` + `page-read` routes (Output
 * pane relay) and the app-serve visitor head. Extracted so the allowlist
 * checks — `pages.tools` / `pages.reads` re-derived from the applied type's
 * manifest, schema validation, `bind` merge order, traversal fences, size
 * caps — can never diverge between the desktop and a served site.
 *
 * Results carry the exact HTTP status + JSON body the historical routes
 * produced; callers stay thin adapters (auth + rate limits + `c.json`).
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { InvokePageToolRequest, PageReadRequest } from '@bendyline/gezel';
import { createLogger, formatJsonSchemaViolations, validateJsonSchema } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatManager } from '../chat/manager.js';
import { realpathContained, safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { dispatchToolReaction } from '../project-type/reactions.js';
import {
  resolvePageReads,
  resolvePageTools,
  resolveProjectTypeManifest,
} from '../project-type/script-tools.js';
import type { ScriptRunner } from '../scripts/runner.js';
import { normalizePreviewPath, pathIsInScope } from './preview-capability.js';

const log = createLogger('page-io');

/**
 * Ceiling on page-invoked script runtime. Page tools are interaction
 * handlers (record a move, flip a card) — anything slower is a design
 * smell, and the cap keeps a buggy LLM-authored page from parking
 * five-minute sandbox runs.
 */
export const PAGE_INVOKE_TIMEOUT_MS = 30_000;

/** Hard ceiling on a single page read; the shim advertises it via `init.limits`. */
export const PAGE_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface PageIoDeps {
  store: Store;
  catalog: CatalogService;
  scriptRunner: ScriptRunner;
  chat: ChatManager;
  history: HistoryManager;
}

/** Status + body exactly as the wire has always carried them. */
export interface PageIoResult {
  status: 200 | 400 | 403 | 404 | 413;
  body: Record<string, unknown>;
}

function etagOf(size: number, mtimeMs: number): string {
  return createHash('sha256')
    .update(`${size}:${Math.trunc(mtimeMs)}`)
    .digest('base64url')
    .slice(0, 16);
}

export async function invokePageTool(
  deps: PageIoDeps,
  args: {
    projectId: string;
    request: InvokePageToolRequest;
    /**
     * Whether a declared `reaction` may summon a gezel turn. First-party
     * (Output pane) invokes always allow it; a serve site allows it only
     * when visitor chat is on — a site without chat never lets a visitor
     * summon a gezel.
     */
    allowReaction: boolean;
    /** Who invoked, for the audit line. */
    origin?: 'page' | 'serve';
  },
): Promise<PageIoResult> {
  const { projectId, request } = args;
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: 'project not found' } };

  const pageTools = await resolvePageTools(deps.catalog, project);
  if (!pageTools) {
    return { status: 404, body: { error: 'project has no applied project type' } };
  }
  const tool = pageTools.tools.find((t) => t.name === request.tool);
  if (!tool) {
    // Distinguish "declared but page-hidden" (a page probing the model
    // surface) from "unknown" for clearer diagnostics.
    const manifest = await resolveProjectTypeManifest(deps.catalog, project);
    return (manifest?.tools ?? []).some((t) => t.name === request.tool)
      ? { status: 403, body: { error: 'tool is not exposed to pages' } }
      : { status: 404, body: { error: 'unknown tool' } };
  }

  // Enforce the tool's declared `inputs` JSON schema on the page's half of
  // the payload only — `bind` is trusted manifest data and merged after, so
  // a schema can never be used to reject (or a page to override) a pinned
  // bind value. Validation is subset-permissive: unknown keywords in an
  // authored schema are ignored, never fatal.
  if (tool.inputs) {
    const violations = validateJsonSchema(request.input ?? {}, tool.inputs);
    if (violations.length > 0) {
      return {
        status: 400,
        body: {
          error: `input does not match tool schema: ${formatJsonSchemaViolations(violations)}`,
        },
      };
    }
  }

  const run = await deps.scriptRunner.run({
    projectId,
    scriptName: tool.script,
    inputs: { ...(request.input ?? {}), ...(tool.bind ?? {}) },
    trigger: { kind: 'page', tool: tool.name },
    timeoutMs: PAGE_INVOKE_TIMEOUT_MS,
  });

  const summary =
    args.origin === 'serve'
      ? `Visitor invoked '${tool.name}' via app serve (${run.status})`
      : `Page invoked '${tool.name}' (${run.status})`;
  await deps.history
    .log({
      kind: 'page.tool.invoked',
      projectId,
      summary,
      details: { tool: tool.name, script: tool.script, runId: run.id, status: run.status },
    })
    .catch((err) => log.warn('[page-invoke] history log failed:', err));

  // The summons never fails the invoke — the user's action already
  // applied; `reaction` in the response says what happened to the turn.
  let reaction: Awaited<ReturnType<typeof dispatchToolReaction>> | undefined;
  if (run.status === 'ok' && tool.reaction) {
    if (args.allowReaction) {
      reaction = await dispatchToolReaction(
        { store: deps.store, chat: deps.chat, history: deps.history },
        {
          project,
          typeName: pageTools.typeName,
          ...(pageTools.params ? { params: pageTools.params } : {}),
          tool,
          run,
        },
      );
    } else {
      reaction = { delivered: false, reason: 'serve-chat-disabled' };
    }
  }

  // Always status 200 for a completed run — a failed script run is a run
  // report the page must read (the error text is its user feedback); 5xx
  // bodies are opaqued by the server-wide sanitizer.
  return {
    status: 200,
    body: {
      runId: run.id,
      status: run.status,
      output: run.output,
      callsSummary: run.calls.map((call) => ({
        kind: call.kind,
        durationMs: call.durationMs,
        ...(call.error ? { error: call.error } : {}),
      })),
      ...(run.error ? { error: run.error } : {}),
      ...(reaction ? { reaction } : {}),
    },
  };
}

/**
 * Resolve a page-declared read target to a verified absolute path: project
 * exists → `pages.reads` scope check (re-derived from the applied type's
 * manifest) → traversal fences. Shared by `readPageData` (JSON reads) and
 * the serve head's `/data` media route so scope enforcement has exactly one
 * implementation.
 */
export async function resolveScopedPageFile(
  deps: Pick<PageIoDeps, 'store' | 'catalog'>,
  args: { projectId: string; source: 'workspace' | 'artifacts'; path: string },
): Promise<{ ok: true; full: string; requested: string } | { ok: false; result: PageIoResult }> {
  const project = await deps.store.getProject(args.projectId).catch(() => null);
  if (!project) {
    return { ok: false, result: { status: 404, body: { error: 'project not found' } } };
  }

  const scopes = await resolvePageReads(deps.catalog, project);
  if (!scopes) {
    return {
      ok: false,
      result: { status: 404, body: { error: 'project has no applied project type' } },
    };
  }

  const requested = normalizePreviewPath(args.path);
  if (requested === null) {
    return { ok: false, result: { status: 400, body: { error: 'bad path' } } };
  }
  const inScope = scopes.some(
    (scope) =>
      scope.source === args.source &&
      (scope.subtree
        ? pathIsInScope(requested, normalizePreviewPath(scope.path) ?? scope.path)
        : requested === normalizePreviewPath(scope.path)),
  );
  if (!inScope) {
    return {
      ok: false,
      result: { status: 403, body: { error: 'path is not a declared page read' } },
    };
  }

  const baseDir =
    args.source === 'workspace'
      ? await deps.store.projectWorkspaceDir(args.projectId)
      : deps.store.projectArtifactsDir(args.projectId);
  const full = safeJoin(baseDir, requested);
  if (!full || !(await realpathContained(baseDir, full))) {
    return { ok: false, result: { status: 400, body: { error: 'path traversal blocked' } } };
  }
  return { ok: true, full, requested };
}

export async function readPageData(
  deps: Pick<PageIoDeps, 'store' | 'catalog'>,
  args: { projectId: string; request: PageReadRequest },
): Promise<PageIoResult> {
  const { projectId, request } = args;
  const resolved = await resolveScopedPageFile(deps, {
    projectId,
    source: request.source,
    path: request.path,
  });
  if (!resolved.ok) return resolved.result;
  const { full, requested } = resolved;

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(full);
  } catch {
    return { status: 404, body: { error: 'not found' } };
  }

  if (request.op === 'stat') {
    if (stats.isDirectory()) {
      // Directory etag folds the listing so a rename/add/delete flips it
      // even when the directory inode's own mtime lags the change.
      const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
      const listed = await Promise.all(
        entries.map(async (entry) => {
          const child = await stat(`${full}/${entry.name}`).catch(() => null);
          return `${entry.name}:${entry.isDirectory() ? 'dir' : 'file'}:${Math.trunc(child?.mtimeMs ?? 0)}`;
        }),
      );
      const digest = createHash('sha256')
        .update(listed.sort().join('\n'))
        .digest('base64url')
        .slice(0, 16);
      return { status: 200, body: { op: 'stat', etag: digest, mtime: stats.mtimeMs } };
    }
    return {
      status: 200,
      body: {
        op: 'stat',
        etag: etagOf(stats.size, stats.mtimeMs),
        size: stats.size,
        mtime: stats.mtimeMs,
      },
    };
  }

  if (request.op === 'list') {
    if (!stats.isDirectory()) return { status: 400, body: { error: 'not a directory' } };
    const entries = await readdir(full, { withFileTypes: true });
    const listed = (
      await Promise.all(
        entries.map(async (entry) => {
          const child = await stat(`${full}/${entry.name}`).catch(() => null);
          if (!child) return null;
          return {
            name: entry.name,
            kind: entry.isDirectory() ? ('dir' as const) : ('file' as const),
            size: child.size,
            mtime: child.mtimeMs,
          };
        }),
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const digest = createHash('sha256')
      .update(
        listed
          .map((e) => `${e.name}:${e.kind}:${Math.trunc(e.mtime)}`)
          .sort()
          .join('\n'),
      )
      .digest('base64url')
      .slice(0, 16);
    return {
      status: 200,
      body: { op: 'list', entries: listed, etag: digest, mtime: stats.mtimeMs },
    };
  }

  if (stats.isDirectory()) return { status: 400, body: { error: 'is a directory' } };
  const cap = Math.min(request.maxBytes ?? PAGE_READ_MAX_BYTES, PAGE_READ_MAX_BYTES);
  if (stats.size > cap) {
    return {
      status: 413,
      body: { error: `file exceeds read cap (${stats.size} > ${cap} bytes)` },
    };
  }
  let buf: Awaited<ReturnType<typeof readFile>>;
  try {
    buf = await readFile(full);
  } catch (err) {
    log.warn(`[page-read] read failed for ${requested}:`, err);
    return { status: 404, body: { error: 'not found' } };
  }
  const as = request.as ?? (requested.endsWith('.json') ? 'json' : 'text');
  const encoding = as === 'bytes' ? 'base64' : 'utf8';
  return {
    status: 200,
    body: {
      op: 'read',
      content: buf.toString(encoding),
      encoding,
      etag: etagOf(stats.size, stats.mtimeMs),
      size: stats.size,
      mtime: stats.mtimeMs,
    },
  };
}
