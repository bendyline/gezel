/**
 * Magic-byte sniffing for attachment safety. Before handing a document to a
 * format parser we confirm its real container type matches the extension we're
 * about to dispatch on — a `.docx` that is actually a PDF (or a raw script
 * renamed to `.xlsx`) is a polyglot / type-confusion attempt and must not be
 * fed to the OOXML importer. This reads only the first handful of bytes; it
 * never parses or decompresses content, so it is safe to run in-process.
 */

export type ContainerKind = 'zip' | 'pdf' | 'unknown';

export interface SniffResult {
  /** The container format detected from the leading bytes. */
  detected: ContainerKind;
  /** True when `detected` is consistent with the file extension. */
  matchesExtension: boolean;
}

// ZIP local-file-header / empty-archive / spanned-archive signatures. All
// OOXML formats (docx/pptx/xlsx) are ZIP containers.
const ZIP_MAGICS: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];
// "%PDF-"
const PDF_MAGIC: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d];

const ZIP_EXTS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub']);
const PDF_EXTS = new Set(['pdf']);

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** Detect the container format from the leading bytes. */
export function detectContainer(bytes: Uint8Array): ContainerKind {
  if (ZIP_MAGICS.some((m) => startsWith(bytes, m))) return 'zip';
  if (startsWith(bytes, PDF_MAGIC)) return 'pdf';
  return 'unknown';
}

const normalizeExt = (ext: string): string => ext.replace(/^\./, '').toLowerCase();

/**
 * Compare the detected container against what the extension implies. Extensions
 * with no binary signature we can verify (e.g. `html`) always match — there's
 * nothing to confuse them with at the magic-byte layer; their safety is handled
 * by the content scanner instead.
 */
export function sniffContainer(bytes: Uint8Array, ext: string): SniffResult {
  const detected = detectContainer(bytes);
  const e = normalizeExt(ext);
  let matchesExtension: boolean;
  if (ZIP_EXTS.has(e)) matchesExtension = detected === 'zip';
  else if (PDF_EXTS.has(e)) matchesExtension = detected === 'pdf';
  else matchesExtension = true; // no magic expectation for this extension
  return { detected, matchesExtension };
}
