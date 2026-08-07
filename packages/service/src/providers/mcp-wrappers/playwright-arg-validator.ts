/**
 * Playwright MCP — argument validator.
 *
 * Catches the most common small-model failure mode: passing a search
 * query (`url: "world news"`) where a real URL is needed. Without
 * validation, playwright-mcp tries to navigate, hangs for 5+ seconds,
 * times out, and returns a generic error — the model takes that as
 * confirmation it doesn't know what to do and fabricates a result.
 *
 * The validator catches the obvious case before it hits the wire and
 * returns a synthetic teaching error: "'world news' is not a URL —
 * use https://... or ask the user". Models trained on tool errors
 * react to this much better than to a navigation timeout, and the
 * 5-second hang is gone.
 *
 * Scope: only `browser_navigate.url` for now. Other malformed-arg
 * cases (missing `ref`, etc.) already produce reasonable upstream
 * errors. Add more rules here when a specific failure pattern proves
 * itself worth catching.
 */
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from '../mcp-bridge.js';
import { isPlaywrightMcp } from './playwright-snapshot.js';
import type { McpPreProcessVerdict, McpToolWrapper, McpToolWrapperContext } from './types.js';

const URL_SCHEME_RE = /^https?:\/\//i;
const FILE_SCHEME_RE = /^file:/i;

/**
 * Browser primitives that remain useful for rendered-page QA without
 * granting arbitrary JavaScript execution, local file upload, storage
 * mutation, or Playwright's unsafe code runner. Navigation is separately
 * constrained to a capability-scoped workspace preview URL.
 */
export const LOCAL_PREVIEW_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_press_key',
  'browser_resize',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
]);

const FILE_OUTPUT_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'browser_console_messages',
  'browser_snapshot',
  'browser_take_screenshot',
]);

function hasCliOption(args: readonly string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

const LOCAL_PREVIEW_NETWORK_OPTIONS = [
  '--proxy-server',
  '--proxy-bypass',
  '--allowed-origins',
  '--blocked-origins',
] as const;

export function hasLocalPreviewBrowserNetworkOverride(args: readonly string[]): boolean {
  return LOCAL_PREVIEW_NETWORK_OPTIONS.some((option) => hasCliOption(args, option));
}

/**
 * Harden a Playwright MCP child for local-preview-only operation. Chromium
 * sends every HTTP(S) request through Gezel's preview-only listener; that
 * listener serves capability paths itself, rejects non-preview paths, and is
 * not a forwarding proxy. `<-loopback>` disables Chromium's implicit bypass
 * for arbitrary localhost services. The upstream origin filter and service
 * worker block are useful extra layers, but are not treated as the boundary.
 */
export function localPreviewBrowserLaunchArgs(
  previewOrigin: string,
  existingArgs: readonly string[],
): string[] {
  const additions: string[] = [];
  if (!hasCliOption(existingArgs, '--proxy-server')) {
    additions.push('--proxy-server', previewOrigin);
  }
  if (!hasCliOption(existingArgs, '--proxy-bypass')) {
    additions.push('--proxy-bypass', '<-loopback>');
  }
  if (!hasCliOption(existingArgs, '--allowed-origins')) {
    additions.push('--allowed-origins', previewOrigin);
  }
  if (!hasCliOption(existingArgs, '--block-service-workers')) {
    additions.push('--block-service-workers');
  }
  return additions;
}

function looksLikeUrl(value: string): boolean {
  if (!value) return false;
  if (URL_SCHEME_RE.test(value)) return true;
  // Allow `about:blank` and similar URI schemes Playwright accepts.
  if (/^[a-z]+:/i.test(value) && !value.includes(' ')) return true;
  return false;
}

function rejectionMessage(badValue: string): string {
  return `'${badValue}' is not a URL. browser_navigate requires a full URL beginning with https:// or http:// (e.g. https://news.ycombinator.com, https://www.bbc.com/news, https://www.reuters.com/world/). Search queries like "world news" are NOT valid URLs — pick a real URL, or tell the user you don't have one and ask which site they want. Do NOT retry with another search query.`;
}

function localFileRejectionMessage(detail?: string): string {
  return `file:// navigation could not be mapped to an HTML file in the active project workspace${detail ? `: ${detail}` : ''}. Use \`file:///workspace/index.html\` (replacing index.html with the real workspace-relative path), or call \`validate({ path: "index.html" })\`. Gezel automatically hosts mapped workspace pages on its scoped preview server; do NOT install \`serve\` or another static server.`;
}

function localPreviewOnlyRejectionMessage(): string {
  return 'This browser is in local-preview-only mode because External services are disabled. Navigate with `file:///workspace/index.html` (using the real workspace-relative HTML path); Gezel will host it on a short-lived preview URL. External URLs, arbitrary localhost services, JavaScript evaluation, file uploads, and unsafe browser code are unavailable in this security mode.';
}

function isScopedWorkspacePreviewUrl(
  raw: string,
  workspace: NonNullable<McpToolWrapperContext['workspacePreview']>,
): boolean {
  if (!workspace.origin) return false;
  try {
    const candidate = new URL(raw);
    if (candidate.origin !== new URL(workspace.origin).origin) return false;
    const segments = candidate.pathname.split('/').filter(Boolean);
    if (
      segments.length < 5 ||
      segments[0] !== 'preview' ||
      !/^[A-Za-z0-9_-]{43}$/.test(segments[1] ?? '') ||
      segments[2] !== 'workspace'
    ) {
      return false;
    }
    return decodeURIComponent(segments[3] ?? '') === workspace.projectId;
  } catch {
    return false;
  }
}

function withoutFilenameArg(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(args, 'filename')) return args;
  const next = { ...args };
  delete next.filename;
  return next;
}

function withoutFilenameSchema(
  tool: Parameters<NonNullable<McpToolWrapper['decorateTools']>>[0][number],
): typeof tool {
  if (!FILE_OUTPUT_BROWSER_TOOLS.has(tool.name)) return tool;
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return tool;
  const nextProperties = { ...(properties as Record<string, unknown>) };
  delete nextProperties.filename;
  const required = Array.isArray(tool.parameters.required)
    ? tool.parameters.required.filter((name) => name !== 'filename')
    : tool.parameters.required;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: nextProperties,
      ...(required ? { required } : {}),
    },
  };
}

export interface WorkspaceFileNavigation {
  relativePath: string;
  search: string;
  hash: string;
}

function normalizeRelativeHtmlPath(input: string): string | null {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return 'index.html';
  if (parts.some((part) => part === '..' || part.includes('\0'))) return null;
  const candidate = parts.join('/');
  return /\.html?$/i.test(candidate) ? candidate : null;
}

/**
 * Resolve a file URL to the active workspace without granting arbitrary
 * filesystem reads. Real absolute URLs inside the workspace work directly.
 * Models also get two stable aliases that do not require knowing the host OS:
 * `file:///workspace/<path>` and any path containing the active project id.
 * Both aliases still resolve only inside the current project's preview root.
 */
export function workspaceFileNavigation(
  raw: string,
  workspace: { root: string; projectId: string },
): WorkspaceFileNavigation | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;

  try {
    const absolutePath = fileURLToPath(parsed);
    const rel = relative(workspace.root, absolutePath);
    const slashRel = rel.replaceAll('\\', '/');
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !slashRel.startsWith('../'))) {
      const relativePath = normalizeRelativeHtmlPath(rel);
      if (relativePath) {
        return { relativePath, search: parsed.search, hash: parsed.hash };
      }
    }
  } catch {
    // A foreign-OS or synthetic file URL cannot be converted to a native
    // absolute path. The workspace/project aliases below remain portable.
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname).replaceAll('\\', '/');
  } catch {
    return null;
  }
  const segments = decodedPath.split('/').filter(Boolean);
  const projectIndex = segments.lastIndexOf(workspace.projectId);
  const workspaceIndex = segments.lastIndexOf('workspace');
  const markerIndex = Math.max(projectIndex, workspaceIndex);
  if (markerIndex < 0) return null;
  const tail = segments.slice(markerIndex + 1);
  if (tail[0] === 'workspace') tail.shift();
  const relativePath = normalizeRelativeHtmlPath(tail.join('/'));
  return relativePath ? { relativePath, search: parsed.search, hash: parsed.hash } : null;
}

export const PlaywrightArgValidator: McpToolWrapper = {
  id: 'playwright-arg-validator',
  matches: (spec: McpServerSpec) => isPlaywrightMcp(spec),
  decorateTools(tools, ctx) {
    if (!ctx.workspacePreview?.localOnly) return tools;
    return tools
      .filter((tool) => LOCAL_PREVIEW_BROWSER_TOOLS.has(tool.name))
      .map(withoutFilenameSchema);
  },
  async preProcess(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    const localOnly = ctx.workspacePreview?.localOnly === true;
    if (localOnly && !LOCAL_PREVIEW_BROWSER_TOOLS.has(toolName)) {
      return { kind: 'reject', error: localPreviewOnlyRejectionMessage() };
    }
    const safeArgs =
      localOnly && FILE_OUTPUT_BROWSER_TOOLS.has(toolName) ? withoutFilenameArg(args) : args;
    if (toolName !== 'browser_navigate') {
      return safeArgs === args ? { kind: 'allow' } : { kind: 'allow', args: safeArgs };
    }
    const raw = args.url;
    if (typeof raw !== 'string') return { kind: 'allow' };
    const trimmed = raw.trim();
    if (FILE_SCHEME_RE.test(trimmed)) {
      if (!ctx.workspacePreview) {
        return { kind: 'reject', error: localFileRejectionMessage('preview hosting unavailable') };
      }
      const target = workspaceFileNavigation(trimmed, ctx.workspacePreview);
      if (!target) {
        return {
          kind: 'reject',
          error: localFileRejectionMessage('path is outside the workspace'),
        };
      }
      try {
        const previewUrl = await ctx.workspacePreview.createUrl(target.relativePath);
        if (!previewUrl) {
          return {
            kind: 'reject',
            error: localFileRejectionMessage(
              `workspace file "${target.relativePath}" was not found`,
            ),
          };
        }
        const hosted = new URL(previewUrl);
        hosted.search = target.search;
        hosted.hash = target.hash;
        return { kind: 'allow', args: { ...args, url: hosted.toString() } };
      } catch (err) {
        return {
          kind: 'reject',
          error: localFileRejectionMessage(
            `preview hosting failed (${err instanceof Error ? err.message : String(err)})`,
          ),
        };
      }
    }
    if (localOnly) {
      if (trimmed === 'about:blank') return { kind: 'allow' };
      if (ctx.workspacePreview && isScopedWorkspacePreviewUrl(trimmed, ctx.workspacePreview)) {
        return { kind: 'allow' };
      }
      return { kind: 'reject', error: localPreviewOnlyRejectionMessage() };
    }
    if (looksLikeUrl(trimmed)) return { kind: 'allow' };
    return { kind: 'reject', error: rejectionMessage(trimmed) };
  },
};
