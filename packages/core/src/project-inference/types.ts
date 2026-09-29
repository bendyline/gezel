/**
 * Shared types for document → project-folder inference.
 *
 * Everything in `project-inference/` is pure: callers pass the platform,
 * home directory, environment and temp directory explicitly, and filesystem
 * access goes through an injected {@link FsProbe}. That keeps every rule
 * testable for all three platforms from any host, and keeps the daemon the
 * only place that decides what "this user's home" is.
 */

export type InferencePlatform = 'win32' | 'darwin' | 'linux';

export type WellKnownKind =
  | 'documents'
  | 'pictures'
  | 'desktop'
  | 'downloads'
  | 'music'
  | 'videos'
  | 'cloud';

export type CloudProvider =
  | 'onedrive'
  | 'icloud'
  | 'dropbox'
  | 'gdrive'
  | 'box'
  | 'nextcloud'
  | 'other';

export interface WellKnownFolder {
  kind: WellKnownKind;
  /** Absolute path, normalized for the platform. Existence is NOT checked here. */
  path: string;
  /** Human label ("Documents", "OneDrive", "iCloud Drive"). */
  label: string;
  cloud?: CloudProvider;
  source: 'default' | 'env' | 'xdg' | 'cloud-root' | 'cloud-child';
}

export interface WellKnownContext {
  platform: InferencePlatform;
  homedir: string;
  env: Record<string, string | undefined>;
  /** Raw contents of `~/.config/user-dirs.dirs` (Linux), read by the caller. */
  userDirs?: string | null;
  /** Entry names under `~/Library/CloudStorage` (macOS), listed by the caller. */
  cloudStorageEntries?: readonly string[];
}

export interface ForbiddenContext extends WellKnownContext {
  tmpdir: string;
  /**
   * Replaces the platform's standard temp locations (`/tmp`, `/private/var/folders`…).
   * `tmpdir` and the TEMP/TMP/TMPDIR environment values still apply. Tests
   * whose fixture tree lives under the real temp dir set this to `[]`.
   */
  tempRoots?: readonly string[];
  gezelHome: string;
  machineSharedHome?: string | null;
  externalFolders?: { gezels?: string; projects?: string };
}

export type ForbiddenReason =
  | 'filesystem-root'
  | 'network-root'
  | 'mount-root'
  | 'user-home'
  | 'home-container'
  | 'gezel-home'
  | 'temp-dir'
  | 'system-dir'
  | 'per-user-app-data'
  | 'hidden-home-dir'
  | 'cloud-root-parent';

export interface FsEntry {
  name: string;
  isDir: boolean;
}

/**
 * Directory listing seam. Return `null` when the directory is unreadable or
 * larger than the caller is willing to scan; the algorithm treats both as
 * "stop here" rather than as evidence.
 */
export interface FsProbe {
  listDir(path: string): Promise<readonly FsEntry[] | null>;
}

export interface ExistingProjectRef {
  id: string;
  /** Absolute, ideally realpath'd by the caller. */
  workingDir: string;
  name: string;
  sharedLibrary: boolean;
}

export interface InferencePolicy {
  /**
   * Inside a well-known root, `full` runs the sibling-shape scorer so
   * `Documents/engineeringdocs/{alpha,bravo}` resolves to `engineeringdocs`;
   * `markers-only` honours only strong markers (`.git`, `.gezel`, …) and
   * otherwise returns the well-known root itself.
   */
  climbInsideWellKnown: 'markers-only' | 'full';
  /** Levels above the document's folder the climb may consider. */
  maxClimb: number;
  /** Directories with more entries than this are not scanned. */
  maxEntriesPerDir: number;
  /** Minimum candidate score for a climb result. */
  scoreThreshold: number;
  /** How many levels above the start the sibling-shape signal is evaluated. */
  shapeProbeLevels: number;
  /** Cap on child folders inspected by the sibling-shape signal. */
  maxChildrenProbed: number;
  /** Cap on grandchild folders inspected per child. */
  maxGrandchildrenProbed: number;
}

export const DEFAULT_INFERENCE_POLICY: InferencePolicy = {
  climbInsideWellKnown: 'full',
  maxClimb: 6,
  maxEntriesPerDir: 2000,
  scoreThreshold: 2,
  shapeProbeLevels: 2,
  maxChildrenProbed: 20,
  maxGrandchildrenProbed: 5,
};

export interface CandidateScore {
  marker: number;
  shape: number;
  container: number;
  depth: number;
  total: number;
}

export type InferWarning = 'existing-project-at-forbidden-root';

export type InferOutcome =
  | {
      matchedBy: 'existing';
      projectId: string;
      root: string;
      name: string;
      sharedLibrary: boolean;
      warnings: InferWarning[];
    }
  | {
      matchedBy: 'well-known';
      root: string;
      name: string;
      folder: WellKnownFolder;
      warnings: InferWarning[];
    }
  | {
      matchedBy: 'climb';
      root: string;
      name: string;
      score: CandidateScore;
      folder?: WellKnownFolder;
      warnings: InferWarning[];
    }
  | {
      matchedBy: 'parent';
      root: string;
      name: string;
      folder?: WellKnownFolder;
      warnings: InferWarning[];
    }
  | {
      matchedBy: 'default';
      root?: undefined;
      reason: ForbiddenReason | 'no-candidate';
      warnings: InferWarning[];
    };

export type InferMatchedBy = InferOutcome['matchedBy'];
