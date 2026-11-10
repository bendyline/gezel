/**
 * A `.txt` file is text as typed: its line breaks are its layout. The
 * document editor reads `.txt` as Markdown, which joins lines into one
 * paragraph and offers formatting keys, so a read-only view shows plain text
 * as preformatted text instead, and an editor opens it in its source view.
 */
export function isPlainTextFile(path: string): boolean {
  return /\.(?:txt|text)$/i.test(path);
}
