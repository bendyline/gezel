/**
 * Normalization shared by the two halves of file-reference recognition:
 * the daemon's parser, which decides which real files an assistant reply
 * named, and the chat UI's linkifier, which turns the matching code spans
 * into clickable links. They must agree on what a path token is, or a file
 * gets a chip in the rail and stays plain text in the bubble.
 */

/**
 * A source locator appended to a path — `:84`, `:84,230`, `:12:5`, or
 * GitHub's `#L42-L51`. Anchored to a digit so a path that legitimately
 * contains `#` or `:` mid-segment survives untouched.
 */
const SOURCE_LOCATOR_RE = /[:#][A-Za-z0-9,:-]*[0-9]$/;

const LEADING_JUNK_RE = /^[('"“”‘’`<[]+/;
const TRAILING_JUNK_RE = /['"“”‘’`)>\].,;:!?]+$/;

/**
 * Strip a trailing source locator. Models writing review prose cite lines
 * far more often than they cite bare paths, so this is the difference
 * between recognizing `image.ts:84,230` and missing it entirely.
 */
export function stripSourceLocator(token: string): string {
  return token.replace(SOURCE_LOCATOR_RE, '');
}

/**
 * Reduce a raw token — a markdown code span, a link target, a bare word in
 * prose — to the path it denotes. Returns `''` when nothing path-like is
 * left. Does not verify that the path exists; that is the caller's
 * inventory lookup.
 */
export function normalizeFileToken(raw: string): string {
  let s = stripSourceLocator(raw.trim());
  s = s.replace(LEADING_JUNK_RE, '').replace(TRAILING_JUNK_RE, '');
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s.trim();
}
