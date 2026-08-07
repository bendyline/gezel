/**
 * Playwright MCP — tool description rewriter.
 *
 * Upstream's `browser_navigate` description ("Navigate to a URL") is
 * too terse for small models. They infer "URL" loosely and pass
 * search queries. We override descriptions for a few tools to spell
 * out what's required, give concrete examples, and warn against the
 * pattern we keep seeing fail.
 *
 * The description rewriter runs once at bridge `start()` time. It
 * doesn't change the JSON-schema (so existing tool-call repair and
 * arg routing keep working) — only the prose the model reads when
 * deciding whether to call the tool.
 */
import type { McpServerSpec, OpenAIFunctionTool } from '../mcp-bridge.js';
import { isPlaywrightMcp } from './playwright-snapshot.js';
import type { McpToolWrapper } from './types.js';

const OVERRIDES: Record<string, string> = {
  browser_navigate:
    'Navigate the browser to a URL. The "url" parameter MUST be a full URL beginning with ' +
    'https:// or http:// — for example https://news.ycombinator.com or https://www.bbc.com/news. ' +
    'For active-project HTML, file:///workspace/index.html (or another workspace-relative path) ' +
    "is automatically rewritten to gezel's capability-scoped preview server; do not install a " +
    'separate static server. Use validate({ path: "index.html" }) when you need the HTML/JS gate ' +
    'without an interactive browser. ' +
    'Search queries like "world news" are NOT valid URLs and will be rejected. If you do not know ' +
    'a real URL for what the user wants, ask them for one rather than guessing. After this ' +
    'returns, you receive an aria-tree snapshot of the page (interactive elements + links + tree) ' +
    'plus a screenshot for visual confirmation. Do not narrate the navigation before the result ' +
    'arrives — wait for the snapshot, then summarize what is on the page.',

  browser_click:
    'Click an element by its accessibility ref. The "ref" parameter must match an [ref=eN] from ' +
    'the most recent snapshot — never invent a ref. The "element" parameter is a short ' +
    'human-readable label for logs. After click, a fresh snapshot is returned automatically.',

  browser_take_screenshot:
    'Take a screenshot of the current page. Returned as an inline image to vision-capable models. ' +
    'No arguments needed for a viewport screenshot. Use "fullPage: true" only when you need the ' +
    'entire scrollable page (rare and expensive).',

  browser_snapshot:
    'Capture the current page as an aria-tree snapshot. **Takes no arguments** — do NOT pass ' +
    '`filename`, `path`, or any other key; the runtime auto-saves the full snapshot to the ' +
    'artifacts drawer and returns its path in the summary. Use this when you already navigated ' +
    'and just want a fresh structural view (e.g. after a click or type). Returns a preview ' +
    'plus the artifact path; navigate the full content via `read_artifact` slices or ' +
    '`grep_artifact`. Each call writes a NEW snapshot at a fresh `auto/...` path — use the ' +
    'one returned in the most recent summary, not a path from earlier in the turn.',
};

export const PlaywrightToolDescriptions: McpToolWrapper = {
  id: 'playwright-tool-descriptions',
  matches: (spec: McpServerSpec) => isPlaywrightMcp(spec),
  decorateTools(tools: OpenAIFunctionTool[]): OpenAIFunctionTool[] {
    return tools.map((t) => {
      const replacement = OVERRIDES[t.name];
      return replacement ? { ...t, description: replacement } : t;
    });
  },
};
