import { parseMarkdown, stringifyMarkdown } from '@bendyline/squisq/markdown';

/**
 * Squisq's serializer is not an identity function over raw markdown — it
 * re-wraps prose at the default wrap width and normalizes things like the
 * trailing newline. An autosave lane that baselines on the RAW stored text
 * therefore reads the editor's first emission of completely unchanged
 * content as an edit: the status flips to "unsaved changes" on a freshly
 * opened page and the debounce fires a spurious write on mere open.
 *
 * Seed autosave lanes that feed a Squisq editor with this round-tripped
 * form instead, so "the user changed nothing" compares equal.
 */
export function normalizeMarkdownBaseline(source: string): string {
  try {
    return stringifyMarkdown(parseMarkdown(source));
  } catch {
    return source;
  }
}
