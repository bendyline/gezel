/**
 * Wire shapes for Settings → Folders: where each state scope lives and the
 * background job that moves one to an external location.
 */

export type FolderScope = 'documents' | 'gezels' | 'projects';
export type FolderMovePolicy = 'overwrite-all' | 'skip-all' | 'use-destination';

/** One pre-move snapshot under `~/.gezel/backup/<timestamp>/`. */
export interface FolderBackupSnapshot {
  id: string;
  path: string;
  scopes: FolderScope[];
  bytes: number;
  /** ISO timestamp, or null when the folder name doesn't parse. */
  createdAt: string | null;
}

export interface FoldersStatusResponse {
  /** Default (un-externalized) location of each scope. */
  defaults: Record<FolderScope, string>;
  /** Currently-resolved location (external if configured, else default). */
  current: Record<FolderScope, string>;
  /** Configured external path per scope, or null when on default. */
  externalized: Record<FolderScope, string | null>;
  /** True when a folder-move job is queued or running — the UI should
   *  disable the move buttons rather than queueing parallel ops. */
  activeJob: boolean;
  /** Latest move job in this service process. Lets the UI recover progress or
   *  the restart prompt when the settings view is remounted. */
  job?: FolderMoveStatus | null;
  /** Pre-move snapshot summary, newest first. */
  backups: {
    count: number;
    totalBytes: number;
    path: string;
    snapshots: FolderBackupSnapshot[];
  };
}

export interface FolderMovePlanValidation {
  ok: boolean;
  reason?: string;
}

export interface FolderMovePlan {
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  files: number;
  bytes: number;
  conflicts: number;
  sourceExists: boolean;
  destExists: boolean;
  destNonEmpty: boolean;
  validation: FolderMovePlanValidation;
}

export interface FolderMoveStatus {
  id: string;
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  conflictPolicy: FolderMovePolicy;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  phase?: 'scan' | 'backup' | 'copy' | 'verify' | 'swap' | 'cleanup' | 'prune';
  filesDone: number;
  totalFiles: number;
  bytesDone: number;
  totalBytes: number;
  error?: string;
  restartRequired: boolean;
  startedAt: string;
  endedAt?: string;
}
