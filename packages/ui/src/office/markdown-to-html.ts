/**
 * The small Markdown subset a gezel writes into a document — headings,
 * paragraphs, bullet and numbered lists (nested by indentation), bold,
 * italic, inline code, code blocks, links — as HTML for Word's `insertHtml`.
 * Everything is escaped first; nothing the model writes becomes markup it
 * did not ask for.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

const LIST_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === '\t' ? 4 : 1;
  return width;
}

export interface MarkdownToHtmlOptions {
  /**
   * HTML for a ```mermaid fence. Without it, the fence stays a code block
   * like any other.
   */
  diagram?: (source: string) => string;
}

export function markdownToHtml(markdown: string, opts: MarkdownToHtmlOptions = {}): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  // Open lists, outermost first. Each level's last item stays open until a
  // sibling, a shallower item, or the end of the list closes it, so a deeper
  // list nests inside it the way Word's insertHtml builds a multi-level list.
  const lists: Array<{ indent: number; tag: 'ul' | 'ol' }> = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    const closed = lists.pop();
    if (closed) out.push(`</li></${closed.tag}>`);
  };
  const flushLists = () => {
    while (lists.length) closeList();
  };
  const openList = (indent: number, tag: 'ul' | 'ol', start: number) => {
    out.push(tag === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${tag}>`);
    lists.push({ indent, tag });
  };
  const nextContentLine = (from: number): string | undefined => {
    for (let j = from; j < lines.length; j++) if (lines[j]!.trim()) return lines[j];
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      flushParagraph();
      flushLists();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(
        fence[1]?.toLowerCase() === 'mermaid' && opts.diagram
          ? opts.diagram(code.join('\n'))
          : `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushLists();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushParagraph();
      const indent = indentWidth(item[1]!);
      const tag = item[3] === undefined ? 'ul' : 'ol';
      while (lists.length && lists[lists.length - 1]!.indent > indent) closeList();
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag !== tag) closeList();
      const level = lists[lists.length - 1];
      if (level && level.indent === indent) out.push('</li>');
      else openList(indent, tag, item[3] === undefined ? 1 : Number(item[3]));
      out.push(`<li>${inline(item[4]!)}`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      // A blank line between items keeps the list going (a "loose" list);
      // only text that is not part of it ends it.
      const next = nextContentLine(i + 1);
      if (lists.length && next !== undefined && (LIST_ITEM_RE.test(next) || /^\s/.test(next))) {
        continue;
      }
      flushLists();
      continue;
    }
    if (lists.length && /^\s/.test(line)) {
      // An indented line under an item continues that item's text.
      out.push(` ${inline(line.trim())}`);
      continue;
    }
    flushLists();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushLists();
  return out.join('');
}
