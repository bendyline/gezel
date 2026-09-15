/**
 * A utf8 decode of binary bytes yields replacement characters rather than
 * failing, so "did this read produce text?" has to be answered after the fact.
 *
 * Shared by the documents store (which refuses to serve a binary as a
 * document) and by retrieval excerpt hydration (which must never splice raw
 * file bytes into a model prompt). Wild-caught on the France PowerPoint turn:
 * a `.jpg` whose index entry was a clean vision description hydrated by
 * re-reading the source file, and 1155 bytes of JPEG mojibake — 27% of the
 * whole injected retrieval block — landed directly above the turn's system
 * route. High-entropy bytes tokenize near 1:1, so the noise costs far more
 * attention than the byte count suggests.
 */
const NUL = 0;
const REPLACEMENT_RATIO = 0.02;

export function looksBinaryText(text: string): boolean {
  const sample = text.slice(0, 4096);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === NUL) return true;
  }
  const replacements = sample.match(/�/g)?.length ?? 0;
  return replacements > sample.length * REPLACEMENT_RATIO;
}
