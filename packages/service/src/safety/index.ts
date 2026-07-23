/**
 * Content- and file-safety primitives for untrusted input (synced email bodies
 * and attachments). Used by the document-conversion pipeline (index-store) and
 * the mail ingest pipeline (mail/).
 */

export { detectContainer, sniffContainer, type ContainerKind, type SniffResult } from './sniff.js';
export {
  guardZipArchive,
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveLimits,
  type ArchiveGuardResult,
} from './archive-guard.js';
export { normalizeText, type NormalizeResult } from './normalize.js';
export {
  scanPatterns,
  scoreHits,
  SEVERITY_WEIGHT,
  type PatternHit,
  type Severity,
} from './patterns.js';
export {
  contentScanner,
  type ContentScanner,
  type ScanInput,
  type ScanVerdict,
  type ScanAction,
  type ScanOrigin,
  type TrustLevel,
} from './scanner.js';
