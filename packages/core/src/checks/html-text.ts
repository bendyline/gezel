/**
 * The text a reader sees in an HTML document, laid out as Markdown so the
 * prose checks read a page the way they read a Markdown deliverable: headings
 * as `#` lines, list items as `-` / `1.`, table rows as `|` rows, links as
 * `[text](href)`, `<code>` as backticks and `<pre>` as a fence. The head,
 * styles, scripts and comments are dropped. Read as plain text, an email
 * digest's `font-size: 14px` and its `<title>` date were facts no source
 * showed (corpus-email-digest, contract replay 2026-11-05).
 */

const HTML_FILE = /\.x?html?$/i;
const HTML_START = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** A file a check should read through `htmlAsMarkdown`: by extension, or by its first tag. */
export function isHtmlDocument(path: string, content: string): boolean {
  return HTML_FILE.test(path) || HTML_START.test(content);
}

const HIDDEN = /<(head|title|style|script|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TOKEN = /<(\/?)([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>|[^<]+|</gi;
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'hr',
  'html',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'summary',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
  times: '×',
  minus: '−',
  deg: '°',
  percnt: '%',
  euro: '€',
  pound: '£',
  cent: '¢',
  yen: '¥',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec || hex) {
      const code = dec ? Number(dec) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code === 0xa0 ? 0x20 : code)
        : whole;
    }
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

function attribute(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

interface Link {
  href: string | null;
  start: number;
}

export function htmlAsMarkdown(html: string): string {
  const source = html.replace(COMMENT, '').replace(HIDDEN, '');
  const out: string[] = [];
  const lists: Array<{ ordered: boolean; n: number }> = [];
  const links: Link[] = [];
  let pre = 0;
  let cell = 0;
  let marker = -1;
  // A paragraph inside a list item or a table cell must not split it from
  // its number or its row: `<li><p>…</p></li>` is still one reference line.
  const newline = () => {
    if (cell > 0) {
      out.push(' ');
      return;
    }
    if (marker >= 0 && out.slice(marker).every((part) => !part.trim())) return;
    marker = -1;
    out.push('\n');
  };

  for (const m of source.matchAll(TOKEN)) {
    const [whole, slash, rawName, attrs = ''] = m;
    if (!rawName) {
      if (whole.startsWith('<') && whole.length > 1) continue;
      const text = decodeEntities(whole);
      out.push(pre > 0 ? text : text.replace(/\s+/g, ' '));
      continue;
    }
    const name = rawName.toLowerCase();
    const closing = slash === '/';
    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      out.push(closing ? '\n' : `\n${'#'.repeat(Number(heading[1]))} `);
    } else if (name === 'pre') {
      pre = Math.max(0, pre + (closing ? -1 : 1));
      out.push('\n```\n');
    } else if (name === 'code') {
      if (pre === 0) out.push('`');
    } else if (name === 'strong' || name === 'b') {
      out.push('**');
    } else if (name === 'ol' || name === 'ul') {
      if (closing) lists.pop();
      else {
        const start = Number(attribute(attrs, 'start'));
        lists.push({
          ordered: name === 'ol',
          n: Number.isInteger(start) && start > 0 ? start - 1 : 0,
        });
      }
      newline();
    } else if (name === 'li') {
      if (!closing) {
        const list = lists.at(-1);
        out.push(list?.ordered ? `\n${++list.n}. ` : '\n- ');
        marker = out.length;
      }
    } else if (name === 'tr') {
      out.push(closing ? '\n' : '\n|');
    } else if (name === 'td' || name === 'th') {
      cell = Math.max(0, cell + (closing ? -1 : 1));
      out.push(closing ? ' |' : ' ');
    } else if (name === 'a') {
      if (!closing) {
        links.push({ href: attribute(attrs, 'href'), start: out.length });
        continue;
      }
      const link = links.pop();
      if (!link) continue;
      const text = out.splice(link.start).join('');
      // An in-page footnote link (`<sup><a href="#fn2">2</a></sup>`) is a
      // numbered citation, which the checks read as `[2]`.
      if (link.href?.startsWith('#') && /^\s*\[?\d{1,3}\]?\s*$/.test(text)) {
        out.push(`[${text.replace(/[^\d]/g, '')}]`);
      } else if (link.href && !link.href.startsWith('#') && !/^javascript:/i.test(link.href)) {
        out.push(`[${text.trim()}](${link.href.replace(/\s/g, '%20')})`);
      } else out.push(text);
    } else if (BLOCK.has(name)) {
      newline();
    }
  }

  // Every check reads line by line, so the blank lines and doubled spaces the
  // page's own indentation leaves between blocks carry nothing. Code keeps its
  // layout.
  const lines: string[] = [];
  let fenced = false;
  for (const line of out.join('').split('\n')) {
    if (line === '```') fenced = !fenced;
    else if (fenced) {
      lines.push(line);
      continue;
    }
    const tidy = line.replace(/\s+/g, ' ').trim();
    if (tidy) lines.push(tidy);
  }
  return lines.join('\n');
}
