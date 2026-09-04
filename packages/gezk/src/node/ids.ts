import { createHash } from 'node:crypto';

/**
 * Stable chunk id: lowercase hex of the FIRST 16 bytes of
 * SHA-256(docId || 0x00 || decimal-ordinal || 0x00 || SHA-256(chunkText) raw
 * 32 bytes). Content-derived so identical inputs on any toolchain produce
 * identical ids — the anchor of both reproducibility and the `#chunk=`
 * citation fragment.
 */
export function chunkUid(documentId: string, ordinal: number, chunkText: string): string {
  const textHash = createHash('sha256').update(chunkText, 'utf8').digest();
  return createHash('sha256')
    .update(documentId, 'utf8')
    .update(Buffer.from([0]))
    .update(String(ordinal), 'utf8')
    .update(Buffer.from([0]))
    .update(textHash)
    .digest('hex')
    .slice(0, 32);
}

/** Full SHA-256 hex of a chunk's text (`chunks.content_hash`). */
export function chunkContentHash(chunkText: string): string {
  return createHash('sha256').update(chunkText, 'utf8').digest('hex');
}
