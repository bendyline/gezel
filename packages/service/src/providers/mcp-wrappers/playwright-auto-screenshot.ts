/**
 * Playwright MCP — auto-screenshot on navigation.
 *
 * `browser_navigate` returns the aria tree but no pixels. Vision-capable
 * models can corroborate the tree against the actual rendered page if
 * they have a screenshot — non-vision models still get a saved image
 * the user can inspect inline with the tool row.
 *
 * This wrapper runs after a successful `browser_navigate` (or
 * `browser_click` / `browser_navigate_back` — any tool that changes
 * the page) and chains a `browser_take_screenshot` call via the
 * wrapper context's back-channel. The returned image content blocks
 * are appended to the navigate result's `images` array, where:
 *
 *   - The bridge's `imagePersister` saves them under the project's
 *     artifacts/ tree so the UI can render thumbnails on the
 *     navigate row.
 *   - Providers that read tool images (OpenAI today; MLX/llama-cpp
 *     after a separate plumbing change) feed them into the model
 *     as `input_image`.
 *
 * Failure modes are silent — if the screenshot call errors or the
 * bridge doesn't expose `browser_take_screenshot`, the navigate
 * result passes through unchanged.
 */
import type { McpServerSpec } from '../mcp-bridge.js';
import { isPlaywrightMcp } from './playwright-snapshot.js';
import type { McpToolResult, McpToolWrapper, McpToolWrapperContext } from './types.js';

/**
 * Tool names that change the page and benefit from a follow-up
 * screenshot. Kept narrow on purpose — auto-attaching images on every
 * `browser_*` call would balloon the context and double UI noise on
 * read-only operations like `browser_console_messages`.
 */
const PAGE_CHANGING_TOOLS = new Set<string>([
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_press_key',
  'browser_select_option',
  'browser_handle_dialog',
]);

const SCREENSHOT_TOOL = 'browser_take_screenshot';

function isPageChangingTool(toolName: string): boolean {
  return PAGE_CHANGING_TOOLS.has(toolName);
}

export const PlaywrightAutoScreenshot: McpToolWrapper = {
  id: 'playwright-auto-screenshot',
  matches: (spec: McpServerSpec) => isPlaywrightMcp(spec),
  async postProcess(
    toolName: string,
    _args: Record<string, unknown>,
    result: McpToolResult,
    ctx: McpToolWrapperContext,
  ): Promise<McpToolResult> {
    if (!isPageChangingTool(toolName)) return result;
    if (!ctx.hasTool(SCREENSHOT_TOOL)) return result;
    let shot: McpToolResult;
    try {
      shot = await ctx.callTool(SCREENSHOT_TOOL, {});
    } catch {
      return result;
    }
    if (shot.images.length === 0) return result;
    return {
      text: `${result.text}\n\n_Auto-attached screenshot (${shot.images.length} image${shot.images.length === 1 ? '' : 's'}) — vision-capable models can see the rendered page._`,
      images: [...result.images, ...shot.images],
    };
  },
};
