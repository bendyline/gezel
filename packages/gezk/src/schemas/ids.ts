import { z } from 'zod';

// Id grammars — frozen with the format; a catalog is addressed by these.

/** DNS-label style: publishers, catalogs, topics. */
export const KNOWLEDGE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export const KnowledgeIdSchema = z.string().regex(KNOWLEDGE_ID_PATTERN);

/**
 * Portable, single-directory catalog version. Versions are identities, not
 * paths: separators, drive/ADS syntax, controls, dot segments, trailing dots
 * or spaces, and Windows device names are all rejected on every platform.
 */
export const KNOWLEDGE_VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/;
export const KnowledgeVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(KNOWLEDGE_VERSION_PATTERN, 'catalog version must be one portable path segment')
  .refine(
    (value) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    'catalog version must not use a reserved Windows device name',
  );

/** C0 and C1 control characters (U+0000–U+001F, U+007F–U+009F). */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/** 1–256 Unicode scalars, NFC, no controls, trimmed. Wikipedia = decimal curid. */
export const KnowledgeDocumentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s === s.normalize('NFC'), 'document id must be NFC-normalized')
  .refine((s) => !hasControlCharacters(s), 'document id must not contain controls')
  .refine((s) => s === s.trim(), 'document id must not have leading/trailing whitespace');

/** Exactly 32 lowercase hex chars (first 16 bytes of the chunk-uid hash). */
export const KnowledgeChunkUidSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** Lowercase hex SHA-256. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
