/**
 * Bounded YAML front matter for the Markdown adapter. Authoring trees use
 * real YAML (nested mappings, negative integers, lists), so the parser is
 * the `yaml` package rather than a line splitter — but held to the core
 * schema (no custom or language tags, so no Dates or binaries reach a
 * document's metadata), with alias nodes disallowed (no expansion attacks)
 * and a size cap, because a catalog build reads files it did not write.
 */

import { parseDocument } from 'yaml';

export const FRONTMATTER_MAX_BYTES = 64 * 1024;

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  body: string;
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
  if (Buffer.byteLength(yamlText, 'utf8') > FRONTMATTER_MAX_BYTES) {
    throw new Error(`front matter exceeds ${FRONTMATTER_MAX_BYTES} bytes`);
  }
  const body = lines.slice(closeAt + 1).join('\n');
  const doc = parseDocument(yamlText, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    logLevel: 'silent',
  });
  // Warnings are things the core schema could not honor (an unknown tag
  // silently becoming a string); a catalog build treats them as errors.
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new Error(`front matter: ${problem.message.split('\n')[0]}`);
  // `maxAliasCount` is a toJS option: 0 disallows alias nodes outright.
  const parsed: unknown = doc.toJS({ maxAliasCount: 0 });
  if (parsed === null || parsed === undefined) return { data: {}, body };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('front matter must be a mapping');
  }
  return { data: parsed as Record<string, unknown>, body };
}
