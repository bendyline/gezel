/**
 * DocBlocks MCP — a preview that cannot launch its browser says so once.
 *
 * `preview_document` renders through Playwright's headless shell. When that
 * browser is missing (a store build, a download still running, a machine
 * that blocks it) DocBlocks answers "browserType.launch: Executable doesn't
 * exist … Run: npx playwright install chromium" — an instruction no gezel
 * can follow, which models answered by retrying the preview up to ten times
 * a step (2026-10-21 sweep). A missing browser does not come back mid-turn,
 * so after the first such failure the session is told plainly to continue
 * without a visual preview, and later preview calls are answered with the
 * same note instead of another launch.
 */
import { isDocblocksMcp } from './docblocks-root-resolver.js';
import type { McpPreProcessVerdict, McpToolWrapper, McpToolWrapperContext } from './types.js';

const BROWSER_MISSING =
  /browserType\.launch|Executable doesn't exist|Playwright Chromium is not installed|playwright install/i;

const unavailable = new WeakSet<McpToolWrapperContext>();

function previewUnavailableNote(ctx: McpToolWrapperContext): string {
  const inspect = ctx.hasTool('inspect_document')
    ? ' Check the document with inspect_document instead, and'
    : '';
  return `preview_document cannot run on this computer: the browser it renders with is not installed. Do not call preview_document again.${inspect} say in your report that no visual preview was made, then continue with the rest of the step.`;
}

export const DocblocksPreviewBrowser: McpToolWrapper = {
  id: 'docblocks-preview-browser',
  matches: isDocblocksMcp,
  async preProcess(
    toolName: string,
    _args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict> {
    if (toolName !== 'preview_document' || !unavailable.has(ctx)) return { kind: 'allow' };
    return { kind: 'reject', error: previewUnavailableNote(ctx) };
  },

  async postProcessError(
    toolName: string,
    _args: Record<string, unknown>,
    errorText: string,
    ctx: McpToolWrapperContext,
  ): Promise<string> {
    if (toolName !== 'preview_document' || !BROWSER_MISSING.test(errorText)) return errorText;
    unavailable.add(ctx);
    return previewUnavailableNote(ctx);
  },
};
