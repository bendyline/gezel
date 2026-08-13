import { z } from 'zod';
import { ProjectGitHubSchema } from '../project.js';

// ── Git operations (per-project, host-agnostic) ─────────────────────

export const GitStatusResponseSchema = z.object({
  github: ProjectGitHubSchema.optional(),
  /** Whether a checkout exists on disk at github.checkoutDir. */
  exists: z.boolean(),
  /** Whether the checkout's `origin` remote matches `github.url`. */
  originMatches: z.boolean().optional(),
  /** Current local branch (HEAD), if exists. */
  branch: z.string().optional(),
  /** Repo default branch, when already detected and cached (never triggers network). */
  defaultBranch: z.string().optional(),
  /** Commits ahead of upstream, if known. */
  ahead: z.number().int().optional(),
  /** Commits behind upstream, if known. */
  behind: z.number().int().optional(),
  /** Working tree dirty (uncommitted changes), if known. */
  dirty: z.boolean().optional(),
  /** Number of changed files in the working tree (renames count once). */
  changesCount: z.number().int().optional(),
  /** Number of files with unresolved merge conflicts. */
  conflictedCount: z.number().int().optional(),
  /** True while a merge started by Sync is waiting on conflict resolution. */
  mergeInProgress: z.boolean().optional(),
  /** True when the current branch has an upstream (or matching origin ref). */
  hasUpstream: z.boolean().optional(),
  /** True when the github toolset has a stored PAT. */
  hasPat: z.boolean(),
  /**
   * Where GitHub credentials come from: a stored toolset PAT, the
   * GH_TOKEN/GITHUB_TOKEN env vars, the signed-in GitHub CLI, or nothing.
   */
  credentialSource: z.enum(['pat', 'env', 'gh', 'none']),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;
export type GitHubCredentialSource = GitStatusResponse['credentialSource'];

export const GitCloneResponseSchema = z.object({
  ok: z.literal(true),
  checkoutDir: z.string(),
  branch: z.string().optional(),
  /** True when a pre-existing repo at workingDir was adopted. */
  adopted: z.boolean(),
});
export type GitCloneResponse = z.infer<typeof GitCloneResponseSchema>;

export const GitBranchSwitchRequestSchema = z.object({
  branch: z.string().min(1),
  /**
   * When true, create the branch from current HEAD (`git checkout -b`).
   * When false/undefined, switch to an existing branch (`git checkout`).
   */
  create: z.boolean().optional(),
});
export type GitBranchSwitchRequest = z.infer<typeof GitBranchSwitchRequestSchema>;

export const GitBranchesResponseSchema = z.object({
  /** Local branches that exist in the checkout. */
  local: z.array(z.string()),
  /** Remote branches under `origin/` with the prefix stripped. Already
   *  deduped against `local` so the UI can render both groups without
   *  double-listing branches that have a tracking pair. */
  remote: z.array(z.string()),
  /** Currently-checked-out branch, when there is one. Undefined in detached HEAD. */
  current: z.string().optional(),
});
export type GitBranchesResponse = z.infer<typeof GitBranchesResponseSchema>;

export const GitFetchResponseSchema = z.object({
  ok: z.literal(true),
  /** True when `git fetch` advanced any ref. */
  fetched: z.boolean(),
});
export type GitFetchResponse = z.infer<typeof GitFetchResponseSchema>;

export const GitCommitRequestSchema = z.object({
  message: z.string().min(1),
  /** Allow committing with no changes. Defaults to false. */
  allowEmpty: z.boolean().optional(),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = z.object({
  ok: z.literal(true),
  sha: z.string(),
  filesChanged: z.number().int(),
});
export type GitCommitResponse = z.infer<typeof GitCommitResponseSchema>;

export const GitPushResponseSchema = z.object({
  ok: z.literal(true),
  pushed: z.boolean(),
  /** When push didn't land, the broad reason class. */
  rejected: z.enum(['non-fast-forward', 'auth', 'unknown']).optional(),
});
export type GitPushResponse = z.infer<typeof GitPushResponseSchema>;

export const GitHubPullSummarySchema = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  url: z.string(),
});
export type GitHubPullSummary = z.infer<typeof GitHubPullSummarySchema>;

export const ListGitHubPullsResponseSchema = z.object({
  pulls: z.array(GitHubPullSummarySchema),
});
export type ListGitHubPullsResponse = z.infer<typeof ListGitHubPullsResponseSchema>;

export const GitHubPullDetailSchema = GitHubPullSummarySchema.extend({
  body: z.string(),
  state: z.string(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
});
export type GitHubPullDetail = z.infer<typeof GitHubPullDetailSchema>;

export const GitHubPullFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changes: z.number().int(),
  /** Unified diff hunk, if requested and returned by GitHub. */
  patch: z.string().optional(),
  /** Character count before Gezel's local patch budget was applied. */
  patchChars: z.number().int().nonnegative().optional(),
  /** True when Gezel clipped `patch`; callers must request the file/diff directly. */
  patchTruncated: z.boolean().optional(),
  /** Prior path when `status === 'renamed'`. */
  previousFilename: z.string().optional(),
});
export type GitHubPullFile = z.infer<typeof GitHubPullFileSchema>;

export const ListGitHubPullFilesResponseSchema = z.object({
  files: z.array(GitHubPullFileSchema),
  /** Total files in the PR before an optional path filter. */
  allFiles: z.number().int().nonnegative().optional(),
  /** Total files selected by the optional path filter. */
  totalFiles: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  includesPatch: z.boolean().optional(),
});
export type ListGitHubPullFilesResponse = z.infer<typeof ListGitHubPullFilesResponseSchema>;

export const GitHubPullCommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** 'issue' = top-level PR comment, 'review' = inline code review comment. */
  kind: z.enum(['issue', 'review']),
  /** For review comments: the file path being commented on. */
  path: z.string().optional(),
});
export type GitHubPullComment = z.infer<typeof GitHubPullCommentSchema>;

export const ListGitHubPullCommentsResponseSchema = z.object({
  comments: z.array(GitHubPullCommentSchema),
});
export type ListGitHubPullCommentsResponse = z.infer<typeof ListGitHubPullCommentsResponseSchema>;

export const GitHubPullDiffResponseSchema = z.object({
  number: z.number().int(),
  diff: z.string(),
  /** Exact changed path when this is a file-scoped diff. */
  path: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  returnedChars: z.number().int().nonnegative().optional(),
  totalChars: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
});
export type GitHubPullDiffResponse = z.infer<typeof GitHubPullDiffResponseSchema>;

export const GitHubCreateCommentRequestSchema = z.object({
  body: z.string().min(1),
});
export type GitHubCreateCommentRequest = z.infer<typeof GitHubCreateCommentRequestSchema>;

export const GitHubCreateCommentResponseSchema = z.object({
  id: z.number(),
  url: z.string(),
});
export type GitHubCreateCommentResponse = z.infer<typeof GitHubCreateCommentResponseSchema>;

export const GitHubCreatePullRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  head: z.string().min(1),
  base: z.string().min(1),
  draft: z.boolean().optional(),
});
export type GitHubCreatePullRequest = z.infer<typeof GitHubCreatePullRequestSchema>;

export const GitHubCreatePullResponseSchema = z.object({
  number: z.number().int(),
  url: z.string(),
});
export type GitHubCreatePullResponse = z.infer<typeof GitHubCreatePullResponseSchema>;

export const GitHubWorkflowRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});
export type GitHubWorkflowRun = z.infer<typeof GitHubWorkflowRunSchema>;

export const ListGitHubWorkflowRunsResponseSchema = z.object({
  runs: z.array(GitHubWorkflowRunSchema),
});
export type ListGitHubWorkflowRunsResponse = z.infer<typeof ListGitHubWorkflowRunsResponseSchema>;

export const GitHubCheckStatusResponseSchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      url: z.string().optional(),
    }),
  ),
});
export type GitHubCheckStatusResponse = z.infer<typeof GitHubCheckStatusResponseSchema>;

// ── GitHub tab: changes / sync / merge (per-project) ─────────────────

export const GitChangeKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'conflicted',
]);
export type GitChangeKind = z.infer<typeof GitChangeKindSchema>;

export const GitWorkingChangeSchema = z.object({
  /** Path relative to the checkout root, forward slashes. */
  path: z.string(),
  /** For renames: the previous path. */
  oldPath: z.string().optional(),
  kind: GitChangeKindSchema,
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  binary: z.boolean().optional(),
});
export type GitWorkingChange = z.infer<typeof GitWorkingChangeSchema>;

export const GitChangesResponseSchema = z.object({
  changes: z.array(GitWorkingChangeSchema),
  /** Total number of changed files before the listing cap. */
  total: z.number().int(),
  truncated: z.boolean(),
});
export type GitChangesResponse = z.infer<typeof GitChangesResponseSchema>;

export const GitFileDiffResponseSchema = z.object({
  path: z.string(),
  kind: GitChangeKindSchema,
  oldPath: z.string().optional(),
  binary: z.boolean(),
  truncated: z.boolean(),
  /** Unified diff text. Absent for binary files. */
  diff: z.string().optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
});
export type GitFileDiffResponse = z.infer<typeof GitFileDiffResponseSchema>;

export const GitDiscardRequestSchema = z
  .object({
    /** Specific files to restore to their last-saved state. */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /** Discard every change in the working tree. */
    all: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.all) !== Boolean(v.paths?.length), {
    message: 'Pass exactly one of `paths` or `all`.',
  });
export type GitDiscardRequest = z.infer<typeof GitDiscardRequestSchema>;

export const GitDiscardResponseSchema = z.object({
  ok: z.literal(true),
  discarded: z.number().int(),
});
export type GitDiscardResponse = z.infer<typeof GitDiscardResponseSchema>;

export const GitLogEntrySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  email: z.string().optional(),
  /** ISO-8601 author date. */
  date: z.string(),
  subject: z.string(),
  filesChanged: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type GitLogEntry = z.infer<typeof GitLogEntrySchema>;

export const GitLogResponseSchema = z.object({
  commits: z.array(GitLogEntrySchema),
  hasMore: z.boolean(),
});
export type GitLogResponse = z.infer<typeof GitLogResponseSchema>;

export const GitCommitDetailResponseSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number().int().optional(),
      deletions: z.number().int().optional(),
      binary: z.boolean().optional(),
    }),
  ),
  /** Unified diff of the whole commit (may be empty for clean merges). */
  diff: z.string().optional(),
  truncated: z.boolean(),
});
export type GitCommitDetailResponse = z.infer<typeof GitCommitDetailResponseSchema>;

export const GitSyncStateSchema = z.enum([
  'synced',
  'needs-save',
  'conflicts',
  'auth',
  'offline',
  'error',
]);
export type GitSyncState = z.infer<typeof GitSyncStateSchema>;

export const GitSyncResponseSchema = z.object({
  state: GitSyncStateSchema,
  /** Commits received from GitHub this sync. */
  pulled: z.number().int(),
  /** Commits sent to GitHub this sync. */
  pushed: z.number().int(),
  /** True when a merge commit was created to combine histories. */
  merged: z.boolean().optional(),
  branch: z.string().optional(),
  conflictedFiles: z.array(z.string()).optional(),
  /** Human-readable detail for `state: 'error'`. */
  message: z.string().optional(),
});
export type GitSyncResponse = z.infer<typeof GitSyncResponseSchema>;

export const GitConflictKindSchema = z.enum([
  'both-modified',
  'both-added',
  'deleted-by-us',
  'deleted-by-them',
]);
export type GitConflictKind = z.infer<typeof GitConflictKindSchema>;

export const GitConflictFileSchema = z.object({
  path: z.string(),
  kind: GitConflictKindSchema,
});
export type GitConflictFile = z.infer<typeof GitConflictFileSchema>;

export const GitMergeStateResponseSchema = z.object({
  inMerge: z.boolean(),
  conflicts: z.array(GitConflictFileSchema),
});
export type GitMergeStateResponse = z.infer<typeof GitMergeStateResponseSchema>;

export const GitConflictVersionsResponseSchema = z.object({
  path: z.string(),
  /** Common-ancestor content. Absent when both sides added the file. */
  base: z.string().optional(),
  /** The local ("keep mine") side. Absent when deleted locally. */
  ours: z.string().optional(),
  /** The remote ("keep GitHub's") side. Absent when deleted on GitHub. */
  theirs: z.string().optional(),
  binary: z.boolean(),
  /** True when a side exceeded the content cap — contents omitted. */
  tooLarge: z.boolean(),
});
export type GitConflictVersionsResponse = z.infer<typeof GitConflictVersionsResponseSchema>;

export const GitResolveConflictRequestSchema = z
  .object({
    path: z.string().min(1),
    choice: z.enum(['mine', 'theirs', 'custom']),
    /** Full file content; required when `choice` is `custom`. */
    content: z.string().optional(),
  })
  .refine((v) => v.choice !== 'custom' || v.content !== undefined, {
    message: '`content` is required when choice is `custom`.',
  });
export type GitResolveConflictRequest = z.infer<typeof GitResolveConflictRequestSchema>;

export const GitResolveConflictResponseSchema = z.object({
  ok: z.literal(true),
  /** Conflicted files still unresolved after this resolution. */
  remaining: z.number().int(),
});
export type GitResolveConflictResponse = z.infer<typeof GitResolveConflictResponseSchema>;

export const GitCompleteMergeRequestSchema = z.object({
  message: z.string().optional(),
});
export type GitCompleteMergeRequest = z.infer<typeof GitCompleteMergeRequestSchema>;

export const GitCompleteMergeResponseSchema = z.object({
  ok: z.literal(true),
  sha: z.string(),
});
export type GitCompleteMergeResponse = z.infer<typeof GitCompleteMergeResponseSchema>;

export const GitAbandonMergeResponseSchema = z.object({
  ok: z.literal(true),
});
export type GitAbandonMergeResponse = z.infer<typeof GitAbandonMergeResponseSchema>;

export const GitSuggestMessageResponseSchema = z.object({
  message: z.string(),
});
export type GitSuggestMessageResponse = z.infer<typeof GitSuggestMessageResponseSchema>;

export const GitAiMergeRequestSchema = z.object({
  path: z.string().min(1),
});
export type GitAiMergeRequest = z.infer<typeof GitAiMergeRequestSchema>;

export const GitAiMergeResponseSchema = z.object({
  path: z.string(),
  /** Proposed merged file content — a preview, never auto-applied. */
  merged: z.string(),
});
export type GitAiMergeResponse = z.infer<typeof GitAiMergeResponseSchema>;

// ── Code review (git change-set reviews) ────────────────────────────
// Pure local-git feature (no GitHub API involved), hence the unprefixed
// CodeReview* names — the SecurityFinding* precedent for project routes.

export const CodeReviewKindSchema = z.enum(['commit', 'pr']);
export type CodeReviewKind = z.infer<typeof CodeReviewKindSchema>;

/**
 * Persisted lifecycle only. "Paused / needs attention" is a live *task*
 * condition derived at read time (see {@link CodeReviewSchema}), never
 * persisted — the settle hook is the record's single writer after start.
 */
export const CodeReviewStatusSchema = z.enum(['running', 'complete', 'canceled', 'error']);
export type CodeReviewStatus = z.infer<typeof CodeReviewStatusSchema>;

/** The durable per-project review record (code-reviews.json rows). */
export const CodeReviewRecordSchema = z.object({
  /** Sortable id: `{kind}-{YYYYMMDD-HHmmss}-{4 hex}`. */
  id: z.string().min(1),
  kind: CodeReviewKindSchema,
  status: CodeReviewStatusSchema,
  createdAt: z.string(),
  settledAt: z.string().optional(),
  outcome: z.enum(['complete', 'canceled']).optional(),
  /** Status `error` only — why the review record was abandoned. */
  error: z.string().optional(),
  /** The review task, as "{projectId}/{num}". */
  taskRef: z.string().min(1),
  /** Reviewer gezel the task was assigned to. */
  gezelId: z.string().optional(),
  /** Branch under review at snapshot time ("(detached)" for a commit review off-branch). */
  branch: z.string(),
  headSha: z.string(),
  /** pr: "origin/<defaultBranch>"; commit: "HEAD". */
  baseRef: z.string().optional(),
  /** pr: the merge-base sha. */
  baseSha: z.string().optional(),
  filesChanged: z.number().int(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  /** pr only — commits on the branch beyond the base. */
  commitCount: z.number().int().optional(),
  /** File list hit MAX_CHANGE_ENTRIES. */
  filesTruncated: z.boolean(),
  /** changes.diff hit the review diff cap. */
  diffTruncated: z.boolean(),
  /** Artifact paths (relative to the project artifacts drawer). */
  manifestPath: z.string(),
  diffPath: z.string(),
  reportPath: z.string(),
});
export type CodeReviewRecord = z.infer<typeof CodeReviewRecordSchema>;

/** Wire shape: the record enriched with live task-derived fields (best-effort). */
export const CodeReviewSchema = CodeReviewRecordSchema.extend({
  taskStatus: z.enum(['draft', 'paused', 'active', 'complete', 'canceled']).optional(),
  /** True when the review task is paused (e.g. gate maxAttempts exhausted). */
  needsAttention: z.boolean().optional(),
  activeStepName: z.string().optional(),
  stepsTotal: z.number().int().optional(),
  stepsComplete: z.number().int().optional(),
  assigneeName: z.string().optional(),
});
export type CodeReview = z.infer<typeof CodeReviewSchema>;

export const StartCodeReviewRequestSchema = z.object({
  kind: CodeReviewKindSchema,
});
export type StartCodeReviewRequest = z.infer<typeof StartCodeReviewRequestSchema>;

export const StartCodeReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: CodeReviewSchema,
});
export type StartCodeReviewResponse = z.infer<typeof StartCodeReviewResponseSchema>;

export const ListCodeReviewsResponseSchema = z.object({
  reviews: z.array(CodeReviewSchema),
});
export type ListCodeReviewsResponse = z.infer<typeof ListCodeReviewsResponseSchema>;

export const CodeReviewResponseSchema = CodeReviewSchema;
export type CodeReviewResponse = z.infer<typeof CodeReviewResponseSchema>;

export const CancelCodeReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: CodeReviewSchema,
});
export type CancelCodeReviewResponse = z.infer<typeof CancelCodeReviewResponseSchema>;

/**
 * The snapshot manifest written to `reviews/<reviewId>/manifest.json` in
 * the project artifacts drawer — the reviewer gezel's stable input. The
 * unified diff lives beside it (`diffFile`); for branch reviews the
 * commit list is embedded here (no separate commits file).
 */
export const CodeReviewManifestSchema = z.object({
  version: z.literal(1),
  reviewId: z.string().min(1),
  kind: CodeReviewKindSchema,
  projectId: z.string().min(1),
  createdAt: z.string(),
  branch: z.string(),
  headSha: z.string(),
  /** pr: "origin/<defaultBranch>"; commit: "HEAD". */
  baseRef: z.string(),
  /** pr: merge-base sha; commit: the head sha itself. */
  baseSha: z.string(),
  files: z.array(GitWorkingChangeSchema),
  totalFiles: z.number().int(),
  filesTruncated: z.boolean(),
  /** Sibling diff file name (always "changes.diff"). */
  diffFile: z.string(),
  diffChars: z.number().int(),
  diffTruncated: z.boolean(),
  /** pr only — newest first, capped at 200. */
  commits: z.array(GitLogEntrySchema).optional(),
  commitsTruncated: z.boolean().optional(),
  /** Human-readable caveats (offline fetch, binary files excluded, …). */
  notes: z.array(z.string()),
});
export type CodeReviewManifest = z.infer<typeof CodeReviewManifestSchema>;
