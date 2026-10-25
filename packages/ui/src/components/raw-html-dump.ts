// A gezel sometimes emits a whole HTML document inline (an index.html it
// "wrote", say). Rendered as markdown that lands as a hollow page —
// styles and scripts stripped by squisq's sanitizer, bare structure left
// over — which is noise, not signal. When a message is *mostly* raw HTML
// we show its source as a code block instead: honest about what the model
// produced, far easier to read, and immune to the global-style leak that
// raw <style> blocks used to cause.

/** Full-page / styling / scripting markers — their presence in a raw-HTML
 *  node is a strong "this is a document, not chat prose" signal. */
const RAW_HTML_PAGE_MARKER_RE = /<\s*(?:!doctype|html|head|body|style|script)\b/i;

/** Below this many raw-HTML characters we leave the message alone — small
 *  inline HTML (a stray <br>, <sub>…) renders fine as-is. */
const RAW_HTML_DUMP_MIN_CHARS = 120;

/** Minimal structural view of a parsed-markdown node for the raw-HTML scan. */
export type MarkdownWalkNode = {
  type?: string;
  rawHtml?: string;
  children?: MarkdownWalkNode[];
};

/** Sum raw-HTML characters across a parsed-markdown tree and flag whether
 *  any raw-HTML node carries page markers. Fenced code parses as `code`
 *  (not `htmlBlock`), so HTML the model already fenced is left untouched. */
function scanRawHtml(nodes: readonly MarkdownWalkNode[]): { chars: number; pageMarkers: boolean } {
  let chars = 0;
  let pageMarkers = false;
  const visit = (node: MarkdownWalkNode): void => {
    if (node.type === 'htmlBlock' || node.type === 'htmlInline') {
      const raw = node.rawHtml ?? '';
      chars += raw.length;
      if (!pageMarkers && RAW_HTML_PAGE_MARKER_RE.test(raw)) pageMarkers = true;
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return { chars, pageMarkers };
}

/** True when a chat message reads as a raw HTML document/fragment rather
 *  than prose: substantial raw HTML that either dominates the message or
 *  carries page markers. Such messages render better as source. */
export function isRawHtmlDump(nodes: readonly MarkdownWalkNode[], source: string): boolean {
  const { chars, pageMarkers } = scanRawHtml(nodes);
  if (chars < RAW_HTML_DUMP_MIN_CHARS) return false;
  const total = source.trim().length || 1;
  return pageMarkers || chars / total >= 0.5;
}

/** Wrap a message in an ```html fence sized longer than any backtick run
 *  inside it, so arbitrary content can't terminate the block early. */
export function toHtmlCodeFence(source: string): string {
  let longestRun = 0;
  for (const match of source.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}html\n${source}\n${fence}`;
}
