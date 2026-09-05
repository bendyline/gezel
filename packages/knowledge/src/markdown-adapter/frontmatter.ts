/**
 * Bounded YAML for the Markdown adapter. Authoring trees use real YAML
 * (nested mappings, negative integers, lists), so the parser is the `yaml`
 * package rather than a line splitter — but held to the core schema (no
 * custom or language tags, so no Dates or binaries reach a document's
 * metadata), with alias expansion budgeted (no expansion attacks) and a
 * size cap, because a catalog build reads files it did not write.
 */

import { parseDocument } from 'yaml';

export const FRONTMATTER_MAX_BYTES = 64 * 1024;
/** An outline file (`mkdocs.yml`, `_toc.yml`) can list thousands of pages. */
export const OUTLINE_MAX_BYTES = 1024 * 1024;

export interface ParseYamlOptions {
  /** What is being parsed, for error messages. */
  what: string;
  maxBytes?: number;
  /**
   * A tag the core schema does not know (`!!python/name:` in an mkdocs.yml)
   * becomes a string under a warning. Front matter treats that as an error;
   * an outline file reads only the keys it needs and may tolerate it.
   */
  tolerateUnknownTags?: boolean;
  /** Alias expansion budget for `toJS`; 0 disallows alias nodes outright. */
  maxAliasCount?: number;
}

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  body: string;
}

/** Parse one YAML document under the adapter's limits; returns the plain JS value. */
export function parseYaml(text: string, opts: ParseYamlOptions): unknown {
  const maxBytes = opts.maxBytes ?? FRONTMATTER_MAX_BYTES;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`${opts.what} exceeds ${maxBytes} bytes`);
  }
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    logLevel: 'silent',
  });
  const problem = doc.errors[0] ?? (opts.tolerateUnknownTags ? undefined : doc.warnings[0]);
  if (problem) throw new Error(`${opts.what}: ${problem.message.split('\n')[0]}`);
  return doc.toJS({ maxAliasCount: opts.maxAliasCount ?? 0 });
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Split `---` front matter off a Markdown source. A source without an
 * opening fence is all body; an opening fence without a closing one is an
 * error rather than silently becoming body text.
 */
export function parseMarkdownFrontMatter(source: string): ParsedFrontMatter {
  const open = OPEN.exec(source);
  if (!open) return { data: {}, body: source };
  const lines = source.slice(open[0].length).split(/\r?\n/);
  const closeAt = lines.findIndex((line) => CLOSE.test(line));
  if (closeAt === -1) throw new Error('front matter is not closed with ---');
  const yamlText = lines.slice(0, closeAt).join('\n');
  const body = lines.slice(closeAt + 1).join('\n');
  const parsed = parseYaml(yamlText, { what: 'front matter' });
  if (parsed === null || parsed === undefined) return { data: {}, body };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('front matter must be a mapping');
  }
  return { data: parsed as Record<string, unknown>, body };
}
