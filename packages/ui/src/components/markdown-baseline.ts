import { parseMarkdown, stringifyMarkdown } from '@bendyline/squisq/markdown';

/**
 * Squisq's serializer is not an identity function over raw markdown — it
 * re-wraps prose at the default wrap width and normalizes things like the
 * trailing newline. An autosave lane that baselines on the RAW stored text
 * therefore reads the editor's first emission of completely unchanged
 * content as an edit: the status flips to "unsaved changes" on a freshly
 * opened page and the debounce fires a spurious write on mere open.
 */
export function normalizeMarkdownBaseline(source: string): string {
  try {
    return stringifyMarkdown(parseMarkdown(source));
  } catch {
    return source;
  }
}

/**
 * True when two markdown sources mean the same document. Autosave lanes that
 * feed a Squisq editor use this to recognize its re-serialization of an
 * unchanged file.
 *
 * Editors are seeded with the RAW file and compared this way, rather than
 * seeded with the normalized form: the normalized form carries remark's
 * escapes (`\$3.50`, `\#Tag`, a trailing `\` for a hard break), and the
 * editor displays those backslashes literally.
 */
export function markdownEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeMarkdownBaseline(a) === normalizeMarkdownBaseline(b);
}
