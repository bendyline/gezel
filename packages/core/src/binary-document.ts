/**
 * What counts as a binary office/media deliverable, and how to tell whether
 * a file actually IS one.
 *
 * This lived in three places that had already drifted apart: the MCP's
 * document-routing extension set, the eval harness's handoff regex, and —
 * by omission — core's deliverable gates, which knew nothing about it and
 * therefore gated `.docx` and `.pptx` outputs with *text* checks. That
 * omission is the bug this module exists to close:
 *
 *   - A `markdown-report` deliverable at `report.docx` was gated by
 *     "contains a Markdown heading". A real DOCX is a ZIP, so the check
 *     REJECTED correct output and ACCEPTED the Markdown source renamed to
 *     `.docx` — inverted, not merely weak.
 *   - A `slide-deck` at `deck.pptx` was gated by "contains slide|section|
 *     ---". A real PPTX passes only incidentally (ZIP stores the
 *     `ppt/slides/slide1.xml` entry name uncompressed), while a Markdown
 *     deck passes outright.
 *
 * Binary deliverables are produced through DocBlocks (`convert_document` →
 * `preview_document` → `save_artifact`), so the honest floor is "is this
 * the container the extension claims", not "does the text look right".
 */

/** Container format a binary deliverable's bytes must actually be. */
export type BinaryDocumentContainer = 'zip' | 'pdf' | 'gif' | 'mp4';

/**
 * Extension → container. OOXML office formats and EPUB are all ZIP;
 * `dbk` is DocBlocks' own bundle, likewise ZIP.
 */
const CONTAINER_BY_EXTENSION: Readonly<Record<string, BinaryDocumentContainer>> = {
  pptx: 'zip',
  docx: 'zip',
  xlsx: 'zip',
  epub: 'zip',
  dbk: 'zip',
  pdf: 'pdf',
  gif: 'gif',
  mp4: 'mp4',
};

/** Every extension the product treats as a binary document deliverable. */
export const BINARY_DOCUMENT_EXTENSIONS: readonly string[] = Object.keys(CONTAINER_BY_EXTENSION);

export function binaryDocumentExtension(path: string | null | undefined): string | null {
  if (!path) return null;
  const match = /\.([a-z0-9]+)$/i.exec(path.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

export function isBinaryDocumentPath(path: string | null | undefined): boolean {
  const ext = binaryDocumentExtension(path);
  return ext !== null && ext in CONTAINER_BY_EXTENSION;
}

export function binaryDocumentContainer(
  path: string | null | undefined,
): BinaryDocumentContainer | null {
  const ext = binaryDocumentExtension(path);
  return ext ? (CONTAINER_BY_EXTENSION[ext] ?? null) : null;
}

/**
 * Leading magic bytes each container must start with.
 *
 * `mp4` is the exception: its `ftyp` box is at offset 4, behind a 4-byte
 * big-endian box size, so it is matched separately below.
 */
const CONTAINER_MAGIC: Readonly<
  Record<Exclude<BinaryDocumentContainer, 'mp4'>, readonly number[]>
> = {
  // "PK\x03\x04" — a ZIP local file header.
  zip: [0x50, 0x4b, 0x03, 0x04],
  // "%PDF-"
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  // "GIF8" (covers both 87a and 89a).
  gif: [0x47, 0x49, 0x46, 0x38],
};

export interface BinaryDocumentVerdict {
  ok: boolean;
  /** Human-readable reason, suitable for a gate rejection message. */
  detail: string;
}

/**
 * Verify that `bytes` really are the container `path`'s extension claims.
 *
 * Deliberately a SIGNATURE check, not a parse: the point is to reject the
 * substitutions models actually make — Markdown, prose, base64 text, or
 * hand-built XML written straight to a `.pptx` path — without pulling a
 * ZIP/PDF parser into core. Anything that clears this floor came out of a
 * real converter.
 */
export function verifyBinaryDocumentBytes(
  path: string,
  bytes: Uint8Array | null | undefined,
): BinaryDocumentVerdict {
  const container = binaryDocumentContainer(path);
  if (!container) {
    return { ok: false, detail: `${path} is not a known binary document format` };
  }
  if (!bytes || bytes.length === 0) {
    return { ok: false, detail: `${path} is empty` };
  }

  if (container === 'mp4') {
    const ftyp = [0x66, 0x74, 0x79, 0x70];
    const matches = bytes.length >= 12 && ftyp.every((byte, index) => bytes[4 + index] === byte);
    return matches
      ? { ok: true, detail: '' }
      : { ok: false, detail: `${path} has no MP4 \`ftyp\` box — it is not a real MP4` };
  }

  const magic = CONTAINER_MAGIC[container];
  const matches = bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
  if (matches) return { ok: true, detail: '' };

  const route =
    'Produce it through the DocBlocks conversion route rather than writing text to the binary path.';
  return {
    ok: false,
    detail: `${path} is not a real ${container.toUpperCase()} container (${describeSubstitute(bytes)}). ${route}`,
  };
}

/** Name what was written instead, so the rejection is actionable. */
function describeSubstitute(bytes: Uint8Array): string {
  const head = Array.from(bytes.slice(0, 16));
  const printable = head.every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f),
  );
  if (!printable) {
    const hex = head.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    return `starts with ${hex}`;
  }
  const text = new TextDecoder().decode(bytes.slice(0, 40)).replace(/\s+/g, ' ').trim();
  return `it is text starting "${text}"`;
}
