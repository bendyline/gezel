import { KNOWLEDGE_ID_PATTERN, KnowledgeDocumentIdSchema } from './schemas/ids.js';

/**
 * `knowledge://<publisherId>/<catalogId>/<documentId>[#chunk=…|#line=n[-m]]`
 * — the citation grammar. The publisher is part of the authority because
 * catalog ids are only unique per publisher.
 */
export interface KnowledgeUri {
  publisherId: string;
  catalogId: string;
  documentId: string;
  fragment?: { chunk: string } | { lineStart: number; lineEnd?: number };
}

const KNOWLEDGE_URI_PREFIX = 'knowledge://';
const MAX_ENCODED_DOCUMENT_ID = 512;

export function formatKnowledgeUri(uri: KnowledgeUri): string {
  const encodedDoc = uri.documentId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  let out = `${KNOWLEDGE_URI_PREFIX}${uri.publisherId}/${uri.catalogId}/${encodedDoc}`;
  if (uri.fragment) {
    out +=
      'chunk' in uri.fragment
        ? `#chunk=${uri.fragment.chunk}`
        : `#line=${uri.fragment.lineStart}${uri.fragment.lineEnd !== undefined ? `-${uri.fragment.lineEnd}` : ''}`;
  }
  return out;
}

/** Strict parse; null for anything that is not a well-formed knowledge URI. */
export function parseKnowledgeUri(raw: string): KnowledgeUri | null {
  if (!raw.startsWith(KNOWLEDGE_URI_PREFIX)) return null;
  const rest = raw.slice(KNOWLEDGE_URI_PREFIX.length);
  const hashAt = rest.indexOf('#');
  const body = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragmentRaw = hashAt === -1 ? null : rest.slice(hashAt + 1);

  const firstSlash = body.indexOf('/');
  if (firstSlash <= 0) return null;
  const secondSlash = body.indexOf('/', firstSlash + 1);
  if (secondSlash <= firstSlash + 1) return null;
  const publisherId = body.slice(0, firstSlash);
  const catalogId = body.slice(firstSlash + 1, secondSlash);
  const encodedDoc = body.slice(secondSlash + 1);
  if (!KNOWLEDGE_ID_PATTERN.test(publisherId) || !KNOWLEDGE_ID_PATTERN.test(catalogId)) {
    return null;
  }
  if (!encodedDoc || encodedDoc.length > MAX_ENCODED_DOCUMENT_ID) return null;

  let documentId: string;
  try {
    documentId = encodedDoc
      .split('/')
      .map((seg) => {
        if (!seg) throw new Error('empty segment');
        return decodeURIComponent(seg);
      })
      .join('/');
  } catch {
    return null;
  }
  if (!KnowledgeDocumentIdSchema.safeParse(documentId).success) return null;

  const base = { publisherId, catalogId, documentId };
  if (fragmentRaw === null) return base;
  const chunkMatch = /^chunk=([0-9a-f]{32})$/.exec(fragmentRaw);
  if (chunkMatch) return { ...base, fragment: { chunk: chunkMatch[1] as string } };
  const lineMatch = /^line=(\d+)(?:-(\d+))?$/.exec(fragmentRaw);
  if (lineMatch) {
    return {
      ...base,
      fragment: {
        lineStart: Number.parseInt(lineMatch[1] as string, 10),
        ...(lineMatch[2] !== undefined ? { lineEnd: Number.parseInt(lineMatch[2], 10) } : {}),
      },
    };
  }
  return null;
}
