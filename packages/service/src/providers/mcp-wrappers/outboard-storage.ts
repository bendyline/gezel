/**
 * Outboard-storage wrapper — intercepts a small allowlist of tools
 * known to produce large outputs, persists the full payload to the
 * project's artifacts/ tree under a stable `auto/` convention, and
 * substitutes a 1-2K summary + path. The model navigates via
 * follow-up `read_artifact({ path, lines: { start, count } })` /
 * `read_artifact({ head: N })` / `grep_artifact({ path, pattern })`
 * calls instead of swallowing the whole payload at once.
 *
 * Why this exists:
 * - `capToolOutput` clamps a single tool result to ~80K chars (or
 *   smaller adaptive budget). On a Qwen 3.6 27B at 32K ctx, a
 *   `browser_snapshot` of a heavy page like weather.com would
 *   either get truncated mid-tree or saturate the working window
 *   (leaving no room for follow-up reasoning + the next user turn).
 * - The salvage layer is purely defensive — it can't help when the
 *   payload itself is the problem.
 * - Outboard storage moves the bytes off the model's context entirely,
 *   so the conversation stays light and the model can drill in
 *   selectively only for the parts it needs.
 *
 * Allowlist semantics (vs size-triggered):
 * - The model learns ONE shape per allowlisted tool: "browser_snapshot
 *   always returns a summary + path; I read with read_artifact slices."
 *   That predictability is much easier for small models to pattern-
 *   match than a "sometimes inline, sometimes not" response shape.
 * - Tools NOT on the allowlist keep their existing inline behavior
 *   (capToolOutput's truncation footer remains the safety net).
 *
 * Skip conditions (return original output unchanged):
 * - Tool name not in the allowlist.
 * - Output already small (< MIN_OUTBOARD_BYTES). The persistence
 *   overhead exceeds the value when the inline payload would already
 *   fit comfortably.
 * - `ctx.writeArtifact` callback unset (no persister wired). Degrades
 *   to current behavior.
 * - Persister threw (disk full, path collision). Logged + falls
 *   through to the original output capped by capToolOutput.
 */

import { randomBytes } from 'node:crypto';
import type { McpServerSpec } from '../mcp-bridge.js';
import type { McpToolResult, McpToolWrapper, McpToolWrapperContext } from './types.js';

/**
 * Tools whose outputs the wrapper unconditionally persists. Order
 * doesn't matter (Set lookup). Add a tool here when its outputs
 * routinely exceed a few KB and a small model would benefit from
 * navigating slices rather than swallowing the whole thing.
 *
 * Today's set: browser observations + URL fetches + script outputs.
 * Tools that produce small/structured outputs (browser_navigate's
 * "ok"/"failed" status, individual click confirmations) stay inline.
 */
const OUTBOARD_STORAGE_TOOLS = new Set<string>([
  'browser_snapshot',
  'browser_evaluate',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'fetch_url',
  'web_search',
  'run_playwright_script',
  'run_nodejs_script',
  'run_npx',
]);

/**
 * Threshold below which the wrapper skips persistence — the inline
 * payload is already small enough that the round-trip + summary
 * format costs more bytes than the savings. ~2K chars keeps tool
 * confirmations ("Navigated to https://example.com") inline while
 * routing actual snapshots / fetches outboard.
 */
const MIN_OUTBOARD_BYTES = 2_000;

/**
 * Maximum chars of the actual content we include in the inline
 * summary as a preview. The model sees this directly; the rest is
 * one `read_artifact` call away. 600 chars (~150 tokens) gives the
 * model enough texture to know what was returned without making the
 * summary itself a context burden.
 */
const PREVIEW_MAX_CHARS = 600;

/**
 * File extension to use for a tool's persisted artifact. Drives the
 * `Content-Type` and what the artifact UI renders the file as. The
 * actual content is just text either way — extension is metadata.
 *
 * Tools not in the table fall through to `.txt` (catch-all).
 */
const TOOL_EXTENSIONS: Record<string, string> = {
  browser_snapshot: 'yaml',
  browser_evaluate: 'json',
  browser_console_messages: 'txt',
  browser_network_requests: 'json',
  browser_take_screenshot: 'txt',
  fetch_url: 'txt',
  web_search: 'json',
  run_playwright_script: 'txt',
  run_nodejs_script: 'txt',
  run_npx: 'txt',
};

/**
 * Determine the file extension for a persisted artifact. For
 * `fetch_url` we sniff the first 256 chars to pick HTML / JSON / TXT
 * — the model is much more likely to recognize the content category
 * when the extension matches. For other tools the table above is
 * authoritative (they always produce the same shape).
 */
function pickExtension(toolName: string, content: string): string {
  if (toolName === 'fetch_url') {
    const head = content.slice(0, 256).trimStart();
    if (/^<!DOCTYPE|^<html|^<\?xml/i.test(head)) return 'html';
    if (head.startsWith('<')) return 'html';
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    return 'txt';
  }
  return TOOL_EXTENSIONS[toolName] ?? 'txt';
}

/**
 * Build the artifact path for a fresh persistence:
 *   auto/<tool>/<YYYY-MM-DD>/<HH-MM-SS>-<short>.<ext>
 *
 * - `auto/` prefix separates auto-saved from user/agent-authored
 *   artifacts (and gives a future cleanup pass a clean directory
 *   target).
 * - Date / time partitioning keeps directory listings readable when
 *   the user has been busy.
 * - The 6-char random suffix avoids collisions on the same second
 *   (two parallel tool calls landing concurrently).
 */
function buildArtifactPath(toolName: string, content: string, now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const short = randomBytes(3).toString('hex'); // 6 hex chars
  const ext = pickExtension(toolName, content);
  return `auto/${toolName}/${year}-${month}-${day}/${hour}-${minute}-${second}-${short}.${ext}`;
}

/**
 * Build the inline summary that replaces the full payload. Stays
 * under ~1.5K tokens regardless of source size. Includes the
 * navigation hint as the last line so the model has the recipe
 * directly visible when deciding what to do next.
 */
export function buildOutboardSummary(opts: {
  toolName: string;
  artifactPath: string;
  content: string;
}): string {
  const { toolName, artifactPath, content } = opts;
  const totalChars = content.length;
  const totalTokensEst = Math.ceil(totalChars / 4);
  const totalLines = content.split('\n').length;
  const preview = content.slice(0, PREVIEW_MAX_CHARS);
  const previewSuffix =
    content.length > PREVIEW_MAX_CHARS
      ? `\n…[+${(totalChars - PREVIEW_MAX_CHARS).toLocaleString('en-US')} more chars]`
      : '';
  return [
    `Stored full ${toolName} output at: ${artifactPath}`,
    `Total: ${totalChars.toLocaleString('en-US')} chars (~${totalTokensEst.toLocaleString('en-US')} tokens), ${totalLines.toLocaleString('en-US')} lines`,
    '',
    `Preview (first ${Math.min(PREVIEW_MAX_CHARS, totalChars)} chars):`,
    preview + previewSuffix,
    '',
    'Use `read_artifact({ path, lines: { start, count } })` to read a slice,',
    '`read_artifact({ path, head: N })` / `{ tail: N }` for the ends, or',
    '`grep_artifact({ path, pattern })` to search.',
  ].join('\n');
}

export const OutboardStorage: McpToolWrapper = {
  id: 'outboard-storage',
  // Apply universally — the allowlist filter inside `postProcess` is
  // the actual gate. We don't bind to a specific MCP server because
  // the same wrapper handles browser_snapshot (Playwright bridge)
  // AND fetch_url / web_search (gezel-mcp bridge).
  matches: (_spec: McpServerSpec) => true,
  async postProcess(
    toolName: string,
    _args: Record<string, unknown>,
    result: McpToolResult,
    ctx: McpToolWrapperContext,
  ): Promise<McpToolResult> {
    if (!OUTBOARD_STORAGE_TOOLS.has(toolName)) return result;
    if (!result.text || result.text.length < MIN_OUTBOARD_BYTES) return result;
    if (!ctx.writeArtifact) return result;
    const artifactPath = buildArtifactPath(toolName, result.text);
    try {
      await ctx.writeArtifact(artifactPath, result.text);
    } catch {
      // Persister failed (disk full, path collision, etc.). Fall
      // through to the original output — capToolOutput will still
      // protect the model's context.
      return result;
    }
    const summary = buildOutboardSummary({
      toolName,
      artifactPath,
      content: result.text,
    });
    return {
      text: summary,
      // Preserve images — they're useful inline and fit a different
      // budget (vision model sees them as base64 attachments, not
      // text). Outboard storage is a TEXT-channel optimization.
      images: result.images,
    };
  },
};
