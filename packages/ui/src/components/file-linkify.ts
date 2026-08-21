/**
 * Rewrite assistant-reply markdown so inline code spans that match a real
 * project file become clickable `#artifact:` / `#workspace:` links. Squisq's
 * markdown pipeline renders them natively; a click handler on the bubble
 * intercepts the scheme and routes to the References pane.
 *
 * Scope is deliberately narrow: we only rewrite backtick-wrapped code
 * spans, never prose. That keeps the risk of mangling unrelated text near
 * zero — the tradeoff is that a bare "see contact.html" line won't
 * hyperlink even though the server's parser recognized it. The chip row
 * below the bubble covers discoverability for those cases.
 *
 * The set of files comes from the daemon's parser (`referencedFiles`), so
 * this pass never has to decide what exists — only where in the text the
 * already-verified paths appear.
 */

import { type ReferencedFile, type ReferencedFileKind, normalizeFileToken } from '@bendyline/gezel';

const SCHEMES: Record<ReferencedFileKind, string> = {
  artifact: '#artifact:',
  workspace: '#workspace:',
};

/** Transform input markdown, returning the rewritten string. */
export function linkifyFileRefs(markdown: string, files: readonly ReferencedFile[]): string {
  if (!markdown || files.length === 0) return markdown;
  // Index by both full path and basename — the model might write either.
  const byFullPath = new Map<string, ReferencedFile>();
  const byBasename = new Map<string, ReferencedFile[]>();
  for (const file of files) {
    byFullPath.set(file.path.toLowerCase(), file);
    const base = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase();
    const existing = byBasename.get(base);
    if (existing) existing.push(file);
    else byBasename.set(base, [file]);
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
    const hit = resolveCandidate(inner, byFullPath, byBasename);
    if (!hit) return whole;
    // Keep the original span text as the link label — including any
    // `:84,230` locator, which is information the reader wants even though
    // nothing downstream can resolve it. Preserving the backticks' visual
    // weight is the anchor's own class rather than re-wrapping in `<code>`
    // markdown (which breaks the link).
    const escaped = escapeLinkLabel(inner);
    return `[${escaped}](${SCHEMES[hit.kind]}${encodeFilePath(hit.path)})`;
  });

  // Re-insert fenced blocks verbatim. Null bytes are used as placeholder
  // markers because the model never emits them in its own output.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder sentinel
  return rewritten.replace(/\u0000FENCE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? '');
}

/** Extract the file reference from an `#artifact:` / `#workspace:` href. */
export function fileRefFromHref(href: string): ReferencedFile | null {
  for (const [kind, scheme] of Object.entries(SCHEMES) as Array<[ReferencedFileKind, string]>) {
    if (!href.startsWith(scheme)) continue;
    try {
      return { kind, path: decodeURIComponent(href.slice(scheme.length)) };
    } catch {
      return null;
    }
  }
  return null;
}

function resolveCandidate(
  raw: string,
  byFullPath: Map<string, ReferencedFile>,
  byBasename: Map<string, ReferencedFile[]>,
): ReferencedFile | null {
  // Shares the daemon parser's normalization, so a span the server matched
  // by stripping `:1633` gets linkified here rather than silently staying
  // plain while its chip appears below the bubble.
  const cleaned = normalizeFileToken(raw);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  const full = byFullPath.get(lower);
  // A qualified label is an exact claim. Never turn
  // `powerpoint/task-11/deck.pptx` into a link to an unrelated root-level
  // `deck.pptx` just because the basename happens to be unique.
  if (lastSlash >= 0) return full ?? null;
  const candidates = byBasename.get(lower);
  return candidates && candidates.length === 1 ? candidates[0]! : null;
}

function escapeLinkLabel(s: string): string {
  return s.replace(/\]/g, '\\]');
}

function encodeFilePath(s: string): string {
  // Encode URL-ish specials but leave `/` alone so the path shape is
  // still recognizable when it lands in the DOM.
  return s
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
