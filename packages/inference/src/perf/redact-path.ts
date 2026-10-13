/**
 * Request paths whose next segment is a credential. Perf labels are written to
 * the service log, kept in `GET /api/system/perf`, and named in stall lines,
 * so the secret is removed before a label is stored, not when it is shown.
 */
const SECRET_SEGMENTS: ReadonlyArray<readonly [prefix: string, placeholder: string]> = [
  // The capability is the whole of a preview's authorization.
  ['/preview/', '[capability]'],
  // An approved grant hands its bearer token to the first caller that names it.
  ['/v1/apps/grant/', '[grant]'],
];

/**
 * The prefix only counts at the start of a path: the start of the text, after
 * whitespace or a quote (`GET /preview/…`), or right after a URL's origin. A
 * project folder that happens to be called `preview` is not a capability.
 */
const SECRET_PATTERNS = SECRET_SEGMENTS.map(
  ([prefix, placeholder]) =>
    [
      new RegExp(String.raw`(^|[\s"'(=]|/|//[^/\s"']*)(${prefix})[^/?#\s"')]+`, 'gi'),
      `$1$2${placeholder}`,
    ] as const,
);

/** Replace credential path segments anywhere in `text`: a path, a perf label, or a URL. */
export function redactPathSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
