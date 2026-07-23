/**
 * The per-file security hook. Called from the content indexer's hot path for
 * each changed code file, beside symbol/import extraction. Cheap, synchronous
 * regex + entropy scan; writes the file's built-in findings hash-gated (an empty
 * result still clears stale findings for a now-clean file).
 *
 * Kept as its own seam so a future tree-sitter-aware refinement (reusing the
 * parse already produced in `index-store/symbols.ts`) slots in here without
 * touching the indexer.
 */

import type { IndexStore } from '../index-store/index-store.js';
import { scanCode } from './code-patterns.js';

/** Scan one code file and persist its built-in findings. Returns the count. */
export function indexFileSecurity(
  store: IndexStore,
  filePath: string,
  fileHash: string | null,
  content: string,
): number {
  const findings = scanCode(content);
  store.putBuiltinFindings(filePath, fileHash, findings);
  return findings.length;
}
