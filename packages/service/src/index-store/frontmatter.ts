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

/** Serialize a flat string map as a YAML frontmatter block + body. */
export function withFrontmatter(data: Record<string, string>, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return body;
  const lines = keys.map((k) => {
    const v = data[k] ?? '';
    const needsQuote = /[:#"\n]/.test(v);
    return `${k}: ${needsQuote ? JSON.stringify(v) : v}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
