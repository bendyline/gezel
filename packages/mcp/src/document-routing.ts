export interface BinaryDocumentCraftbookRoute {
  craftbookId: string;
  label: string;
}

const ROUTES_BY_EXTENSION: Readonly<Record<string, BinaryDocumentCraftbookRoute>> = {
  pptx: { craftbookId: 'powerpoint-deck', label: 'PowerPoint' },
  docx: { craftbookId: 'research-to-document', label: 'Word document' },
  pdf: { craftbookId: 'report-pdf', label: 'PDF report' },
  mp4: { craftbookId: 'narrated-slideshow', label: 'rendered slideshow' },
  gif: { craftbookId: 'narrated-slideshow', label: 'animated slideshow' },
};

const BINARY_DOCUMENT_EXTENSIONS = new Set([
  ...Object.keys(ROUTES_BY_EXTENSION),
  'xlsx',
  'epub',
  'dbk',
]);

function extension(path: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(path.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Normalize a user-facing workspace/artifact deliverable to the relative path
 * expected by document craftbooks. The craftbook writes this path inside the
 * artifact root and copies the same relative path into the workspace, so a
 * drawer prefix must not become a literal nested `artifacts/` directory.
 */
export function normalizeDocumentOutputPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^(?:workspace|artifacts)\//i, '');
}

export function isBinaryDocumentOutputPath(path: string): boolean {
  const ext = extension(path);
  return ext !== null && BINARY_DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * Return the capability-owned workflow for a binary output, when Gezel has
 * one. A null route is a hard blocker for binary handoff callers; it is not
 * permission to fall back to a Builder.
 */
export function binaryDocumentCraftbookRoute(path: string): BinaryDocumentCraftbookRoute | null {
  const ext = extension(path);
  return ext ? (ROUTES_BY_EXTENSION[ext] ?? null) : null;
}
