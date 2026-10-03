/**
 * `knowledge://` citations in an assistant reply become links the chat bubble
 * opens in the Knowledge area. Models write them three ways: as a Markdown
 * link (left alone), inside a code span, or bare in prose. The last two are
 * rewritten into `[label](uri)` so the bubble's click delegate can route them;
 * fenced code blocks are never touched.
 */

import { type KnowledgeUri, parseKnowledgeUri } from '@bendyline/gezel';

// A URI runs to whitespace, a closing bracket/paren/quote, or a backtick.
const KNOWLEDGE_URI = /knowledge:\/\/[^\s`<>()[\]"']+/g;

/** Short, readable label: `catalog › document` (the passage id is noise to a reader). */
export function knowledgeLinkLabel(uri: KnowledgeUri): string {
  const doc = uri.documentId.split('/').pop() ?? uri.documentId;
  return `${uri.catalogId} › ${doc.replace(/[-_]+/g, ' ')}`;
}

export function linkifyKnowledgeRefs(markdown: string): string {
  if (!markdown || !markdown.includes('knowledge://')) return markdown;
  const fences: string[] = [];
  const withoutFences = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
    fences.push(block);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  const link = (raw: string): string | null => {
    // Trailing sentence punctuation belongs to the prose, not the URI.
    const uriText = raw.replace(/[.,;:!?]+$/, '');
    const uri = parseKnowledgeUri(uriText);
    if (!uri) return null;
    return `[${knowledgeLinkLabel(uri)}](${uriText})${raw.slice(uriText.length)}`;
  };

  const rewritten = withoutFences
    // A code span holding only a URI.
    .replace(/`(knowledge:\/\/[^`\s]+)`/g, (whole, inner: string) => link(inner) ?? whole)
    // A bare URI, unless it is already a Markdown link target or label.
    .replace(KNOWLEDGE_URI, (raw, offset: number, all: string) => {
      const before = all.slice(Math.max(0, offset - 2), offset);
      if (before.endsWith('](') || before.endsWith('[') || before.endsWith('<')) return raw;
      return link(raw) ?? raw;
    });

  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder sentinel
  return rewritten.replace(/\u0000FENCE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? '');
}

/** The citation a clicked href names, or null when it is not a `knowledge://` link. */
export function knowledgeRefFromHref(href: string): KnowledgeUri | null {
  return href.startsWith('knowledge://') ? parseKnowledgeUri(href) : null;
}
