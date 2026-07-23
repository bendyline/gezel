/**
 * Rewrite assistant-reply markdown so inline code spans that match a
 * real project artifact become clickable `#artifact:<canonical-path>`
 * links. Squisq's markdown pipeline renders them natively; a click
 * handler on the bubble intercepts the `#artifact:` scheme and routes
 * to the References pane.
 *
 * Scope is deliberately narrow: we only rewrite backtick-wrapped code
 * spans, never prose. That keeps the risk of mangling unrelated text
 * near zero — the tradeoff is that a bare "see contact.html" line
 * won't hyperlink. The chip row below the bubble covers discoverability
 * for those cases.
 */

/** Transform input markdown, returning the rewritten string. */
export function linkifyArtifactRefs(markdown: string, artifacts: string[]): string {
  if (!markdown || artifacts.length === 0) return markdown;
  // Index by both full path and basename — the model might write either.
  const byFullPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of artifacts) {
    byFullPath.set(p.toLowerCase(), p);
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    const existing = byBasename.get(base);
    if (existing) existing.push(p);
    else byBasename.set(base, [p]);
  }

  // Pull triple-backtick fenced code blocks out so we don't rewrite
  // their contents (the model often quotes the whole file inline).
  // Placeholders preserve order for reinsertion.
  const fences: string[] = [];
  const fencePlaceholder = (i: number) => `\u0000FENCE${i}\u0000`;
  let i = 0;
  const withoutFences = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
    const marker = fencePlaceholder(i++);
    fences.push(block);
    return marker;
  });

  const rewritten = withoutFences.replace(/`([^`\n]{1,200})`/g, (whole, inner) => {
    const canonical = resolveCandidate(inner, byFullPath, byBasename);
    if (!canonical) return whole;
    // Keep the original text as the link label, preserving the leading
    // backticks' visual weight via the anchor's own class rather than
    // re-wrapping in `<code>` markdown (which breaks the link).
    const escaped = escapeLinkLabel(inner);
    return `[${escaped}](#artifact:${encodeArtifactPath(canonical)})`;
  });

  // Re-insert fenced blocks verbatim. Null bytes are used as placeholder
  // markers because the model never emits them in its own output.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder sentinel
  return rewritten.replace(/\u0000FENCE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? '');
}

/** Extract the canonical artifact path from an `#artifact:…` href. */
export function artifactPathFromHref(href: string): string | null {
  if (!href.startsWith('#artifact:')) return null;
  try {
    return decodeURIComponent(href.slice('#artifact:'.length));
  } catch {
    return null;
  }
}

function resolveCandidate(
  raw: string,
  byFullPath: Map<string, string>,
  byBasename: Map<string, string[]>,
): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const full = byFullPath.get(lower);
  if (full) return full;
  const lastSlash = lower.lastIndexOf('/');
  const base = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  const candidates = byBasename.get(base);
  if (candidates && candidates.length === 1) return candidates[0]!;
  return null;
}

function escapeLinkLabel(s: string): string {
  return s.replace(/\]/g, '\\]');
}

function encodeArtifactPath(s: string): string {
  // Encode URL-ish specials but leave `/` alone so the path shape is
  // still recognizable when it lands in the DOM.
  return s
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
