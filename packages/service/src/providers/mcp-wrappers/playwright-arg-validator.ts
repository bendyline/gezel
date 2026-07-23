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
import type { McpServerSpec } from '../mcp-bridge.js';
import { isPlaywrightMcp } from './playwright-snapshot.js';
import type { McpPreProcessVerdict, McpToolWrapper, McpToolWrapperContext } from './types.js';

const URL_SCHEME_RE = /^https?:\/\//i;

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

export const PlaywrightArgValidator: McpToolWrapper = {
  id: 'playwright-arg-validator',
  matches: (spec: McpServerSpec) => isPlaywrightMcp(spec),
  async preProcess(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    if (toolName !== 'browser_navigate') return { kind: 'allow' };
    const raw = args.url;
    if (typeof raw !== 'string') return { kind: 'allow' };
    const trimmed = raw.trim();
    if (looksLikeUrl(trimmed)) return { kind: 'allow' };
    return { kind: 'reject', error: rejectionMessage(trimmed) };
  },
};
