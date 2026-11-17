/**
 * Minimal YAML-frontmatter reader (no yaml dep). Handles the common
 * `--- key: value ---` block at the top of a markdown file — enough for the
 * structured fields source adapters emit (email from/to/date/subject, etc.),
 * which the indexer lifts into the `metadata` table for filtering + meta-queries.
 */

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---')) return { data: {}, body: content };
  // The closing fence is a line that is exactly `---`.
  const m = /\n---[ \t]*(\r?\n|$)/.exec(content);
  if (!m || m.index === undefined) return { data: {}, body: content };
  const block = content.slice(3, m.index);
  const body = content.slice(m.index + m[0].length);
  const data: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (kv) {
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (value) data[key] = value;
    }
  }
  return { data, body };
}

// U+2028 and U+2029 end a line in JavaScript and in YAML 1.1 readers, and
// JSON.stringify leaves them raw; they are built here rather than written as
// escapes so no tool that rewrites escapes can turn them into line breaks.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
/**
 * Any control character is quoted: a bare carriage return or line separator
 * from a source's title would start a new key in other YAML readers.
 */
const NEEDS_QUOTE = new RegExp(`[:#"\\x00-\\x1f\\x7f${LINE_SEPARATORS}]`);
const RAW_SEPARATOR = new RegExp(`[${LINE_SEPARATORS}]`, 'g');

function quoteValue(v: string): string {
  return JSON.stringify(v).replace(RAW_SEPARATOR, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** Serialize a flat string map as a YAML frontmatter block + body. */
export function withFrontmatter(data: Record<string, string>, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return body;
  const lines = keys.map((k) => {
    const v = data[k] ?? '';
    const needsQuote = NEEDS_QUOTE.test(v);
    return `${k}: ${needsQuote ? quoteValue(v) : v}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
