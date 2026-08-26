/**
 * Script-SDK wire types for workspace-index status and readiness.
 *
 * These deliberately live in the self-contained SDK instead of importing
 * the Zod-inferred core types. Script sandboxes and Monaco receive only the
 * SDK declaration files, so an external type import would make that surface
 * depend on another package. The parity test beside this file keeps these
 * structural copies aligned with the canonical core schemas.
 */

export interface WorkspaceIndexStatus {
  state: 'fresh' | 'stale' | 'indexing' | 'never' | 'disabled';
  embeddings?: {
    status: 'cold' | 'warming' | 'ready' | 'disabled' | 'unavailable';
    reason?: string;
  };
  meta?: {
    version: number;
    scannedAt: string;
    root: string;
    durationMs: number;
    fileCount: number;
    commandCount: number;
    shapeCount?: number;
  };
  aiScanPending?: boolean;
  aiDrive?: 'background' | 'full';
  enrichment?: {
    eligible: number;
    summarized: number;
    embedded: number;
    searchReady?: number;
    pending: number;
    skipped?: number;
    skippedFiles?: Array<{
      path: string;
      attempts: number;
      reason?: string;
    }>;
    shadowsPending?: number;
    embedOnlyPending?: number;
    embedModel?: string;
    vectorsAvailable?: boolean;
    reviews?: {
      eligible: number;
      reviewed: number;
      stale: number;
      pending: number;
    };
  };
}

export interface IndexReadinessReport {
  version: 1;
  projectId: string;
  generatedAt: string;
  indexingEnabled: boolean;
  staticState: 'fresh' | 'stale' | 'indexing' | 'never' | 'disabled';
  fileCount?: number;
  scannedAt?: string;
  search: {
    ready: boolean;
    eligible?: number;
    embedded?: number;
    pendingEmbedOnly?: number;
    embedModel?: string;
    vectorsAvailable?: boolean;
  };
  aiTier: {
    staffed: boolean;
    paused: boolean;
    achievable: boolean;
    summariesEligible?: number;
    summarized?: number;
    summariesPending?: number;
    shadowsPending?: number;
    skipped?: number;
    reviews?: {
      eligible: number;
      reviewed: number;
      stale: number;
      pending: number;
    };
  };
  wait: {
    budgetMs: number;
    waitedMs: number;
    drained: boolean;
    driveStillRunning: boolean;
  };
  notes: string[];
}
