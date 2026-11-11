/**
 * Markdown's inline marks taken off text that is shown as plain text: a
 * statement quoted under a reply, a line on a document's cover. Printed as
 * stored, a doubted sentence showed `**Sunday**` with its asterisks
 * (2026-11-09). Forgiving on purpose: an unmatched `*` (5 * 3) stays, and an
 * underscore inside a word (`snake_case`) is not emphasis.
 */
export function plainInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[3]`, `[1, 4]`, `[2-5]` with the space before them. */
const CITATION_MARKER = /\s*\[\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*\](?![(:])/g;

/** A sentence from a reply, as plain words: no markdown and no `[n]` markers. */
export function plainStatement(text: string): string {
  return plainInlineMarkdown(text.replace(CITATION_MARKER, ''));
}
