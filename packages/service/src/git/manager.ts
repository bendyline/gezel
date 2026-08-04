import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CodeReviewKind,
  GitCommitDetailResponse,
  GitConflictFile,
  GitConflictKind,
  GitConflictVersionsResponse,
  GitFileDiffResponse,
  GitLogEntry,
  GitSyncResponse,
  GitWorkingChange,
  ProjectDetail,
  ProjectFileEntry,
  ProjectGitHub,
} from '@bendyline/gezel';
import {
  projectInternalGithubDir,
  projectStorageDir,
  sharedCloneDir,
  sharedClonesRoot,
} from '@bendyline/gezel/paths';
import { createPatch } from 'diff';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { AmbientGitHubAuth } from '../github/ambient.js';
import {
  authenticatedCloneUrl,
  parseGitHubUrl,
  sameGitHubRepo,
  sharedCloneKey,
} from '../github/url.js';
import type { SecretStore } from '../secrets/types.js';
import {
  EMPTY_TREE_SHA,
  LOG_FORMAT,
  MAX_CHANGE_ENTRIES,
  MAX_CONFLICT_SIDE_CHARS,
  MAX_UNTRACKED_STAT_BYTES,
  type NumstatEntry,
  REVIEW_DIFF_MAX_CHARS,
  classifyNameStatus,
  countLines,
  parseLog,
  parseNumstatLines,
  parseNumstatZ,
  parseStatusZ,
  sniffBinary,
  truncateDiff,
} from './changes.js';
import {
  GitError,
  cloneBare,
  isGitInstalled,
  runGit,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from './git.js';
import { inspectGitWorkdir } from './inspect.js';

export { inspectGitWorkdir };
export type { InspectedGit } from './inspect.js';

/**
 * Owns the per-project repo lifecycle: deciding where the checkout lives,
 * cloning, pulling, branch switching, and read-only file access for the UI.
 *
 * Locks are held per project for any state-mutating operation so two
 * simultaneous "Sync" clicks don't race a clone over itself.
 */

const GITHUB_TOOLSET_ID = 'github';
const TOKEN_FIELD_ID = 'token';

/** Capped to keep the response payload sane in the UI; can paginate later. */
const MAX_FILES_RETURNED = 5_000;

/** Files we never try to render or even list — ignored as we walk. */
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

export interface CheckoutResolution {
  /** Absolute path to where the checkout lives or would be cloned. */
  dir: string;
  /** True iff `dir` exists and contains a `.git/` directory. */
  exists: boolean;
  /** True iff exists and `git -C dir remote get-url origin` matches the configured URL. */
  originMatches: boolean;
  /** True iff `dir` is the project's own workingDir (vs a `gh/` subfolder). */
  isAtWorkingDir: boolean;
}

/** Where GitHub API/auth credentials come from, in precedence order. */
export type GitHubCredentialSource = 'pat' | 'env' | 'gh' | 'none';

export interface GitStatus {
  github?: ProjectGitHub;
  exists: boolean;
  originMatches?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  changesCount?: number;
  conflictedCount?: number;
  mergeInProgress?: boolean;
  hasUpstream?: boolean;
  hasPat: boolean;
  credentialSource: GitHubCredentialSource;
}

export class MissingPatError extends Error {
  constructor() {
    super(
      "No GitHub credentials found. Sign in from the project's GitHub tab, " +
        'use the GitHub CLI, or install the "github" toolset in Settings → Toolsets.',
    );
    this.name = 'MissingPatError';
  }
}

export class NoGitHubLinkError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no GitHub repo linked.`);
    this.name = 'NoGitHubLinkError';
  }
}

export class GitNotInstalledError extends Error {
  constructor() {
    super('git is not installed (or not on PATH). Install git to use GitHub repos in Gezel.');
    this.name = 'GitNotInstalledError';
  }
}

export class NoDefaultBranchError extends Error {
  constructor() {
    super("Couldn't work out this repo's main branch — sync once, then try again.");
    this.name = 'NoDefaultBranchError';
  }
}

export class DetachedHeadError extends Error {
  constructor() {
    super('Switch to a branch first, then start the review.');
    this.name = 'DetachedHeadError';
  }
}

export class NothingToReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingToReviewError';
  }
}

/**
 * The isolated change set a code review runs against — everything the
 * CodeReviewManager needs to write `reviews/<id>/manifest.json` +
 * `changes.diff` except the review identity itself.
 */
export interface GitReviewSnapshot {
  kind: CodeReviewKind;
  branch: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: GitWorkingChange[];
  totalFiles: number;
  filesTruncated: boolean;
  diff: string;
  diffTruncated: boolean;
  commits?: GitLogEntry[];
  commitsTruncated?: boolean;
  notes: string[];
}

export class MergeInProgressError extends Error {
  constructor() {
    super('A sync is waiting on conflict resolution — finish or cancel it first.');
    this.name = 'MergeInProgressError';
  }
}

export class NotInMergeError extends Error {
  constructor() {
    super('No sync is waiting on conflict resolution.');
    this.name = 'NotInMergeError';
  }
}

export class ConflictsRemainError extends Error {
  constructor(readonly paths: string[]) {
    super(`Cannot finish the sync — ${paths.length} file(s) still need a resolution.`);
    this.name = 'ConflictsRemainError';
  }
}

export class GitManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly home: string,
    private readonly store: Store,
    private readonly secrets: SecretStore,
    private readonly ambient: AmbientGitHubAuth = new AmbientGitHubAuth(),
  ) {}

  /** Read the PAT from the github toolset's secret store entry. */
  async getPat(): Promise<string | null> {
    return this.secrets.get({
      kind: 'toolset',
      toolsetId: GITHUB_TOOLSET_ID,
      fieldId: TOKEN_FIELD_ID,
    });
  }

  /**
   * Resolve a usable GitHub token: the stored toolset PAT wins, then
   * ambient credentials (GH_TOKEN/GITHUB_TOKEN env vars, then a signed-in
   * GitHub CLI). Ambient tokens are resolved per call and never persisted
   * — they belong to gh and rotate when the user re-auths.
   */
  async getToken(): Promise<string | null> {
    const pat = await this.getPat();
    if (pat) return pat;
    return (await this.ambient.getToken())?.token ?? null;
  }

  /** Which credential source getToken() would use right now. */
  async credentialSource(): Promise<GitHubCredentialSource> {
    if (await this.hasPat()) return 'pat';
    return (await this.ambient.getToken())?.source ?? 'none';
  }

  /** True iff a PAT is stored. Used to gate UI affordances. */
  async hasPat(): Promise<boolean> {
    return this.secrets.has({
      kind: 'toolset',
      toolsetId: GITHUB_TOOLSET_ID,
      fieldId: TOKEN_FIELD_ID,
    });
  }

  /**
   * Phase 3 — shared bare clone management. Multiple projects pointing
   * at the same github URL share a single bare clone at
   * `~/.gezel/git-clones/<key>/`; each project's workspace is a `git
   * worktree add` off that bare. This saves disk space (one
   * `.git/objects` per URL instead of one per project) and unlocks the
   * "PR review + main branch in parallel" workflow without re-fetching.
   *
   * `ensureSharedClone(url)` returns the path to the bare clone for
   * `url`, creating it if missing. Idempotent — concurrent calls for
   * the same URL serialize on the URL's lock.
   */
  async ensureSharedClone(url: string): Promise<string> {
    const key = sharedCloneKey(url);
    if (!key) throw new Error(`Could not derive shared-clone key from URL: ${url}`);
    const dir = sharedCloneDir(this.home, key);
    return this.withLock(`shared:${key}`, async () => {
      // Already cloned? Check by stat + verifying `.git`-shape — bare
      // repos have HEAD, config, refs/ at the root rather than under
      // `.git/`. The cheap check: `git rev-parse --is-bare-repository`
      // inside the dir.
      try {
        await stat(dir);
        const r = await runGit(['rev-parse', '--is-bare-repository'], {
          cwd: dir,
          timeoutMs: 5_000,
        });
        if (r.stdout.trim() === 'true') return dir;
      } catch {
        // doesn't exist or not a bare repo — fall through to clone
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      const parsed = parseGitHubUrl(url);
      // GitHub URLs flow through PAT auth + persisted-remote cleanup.
      // Non-github URLs (local paths, ssh-elsewhere, gitlab/gitea) just
      // get a vanilla `git clone --bare` — the schema accepts them and
      // the worktree mechanics work identically.
      const pat = parsed ? await this.getToken() : null;
      const cloneUrl = parsed ? authenticatedCloneUrl(parsed.cloneUrl, pat) : url;
      await mkdir(dir, { recursive: true });
      await cloneBare(cloneUrl, dir, { redact: pat ? [pat] : [] });
      if (parsed && pat) {
        await runGit(['remote', 'set-url', 'origin', parsed.cloneUrl], { cwd: dir });
      }
      // Bare clones get no fetch refspec by default; install the standard
      // one so fetches maintain refs/remotes/origin/* for sync.
      await runGit(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], {
        cwd: dir,
      }).catch(() => {});
      return dir;
    });
  }

  /**
   * Add a worktree for `project` off the shared bare clone, checked out
   * at `ref` (default = the bare clone's HEAD). The worktree lands at
   * the project's workspace dir, so the model sees the repo files at
   * the workspace root (same principle as Phase 2's direct-into-
   * workspace clone). The shared bare clone is created on demand.
   *
   * Returns the resolved worktree path (which is also the workspace dir).
   */
  async addProjectWorktree(args: {
    projectId: string;
    url: string;
    ref?: string;
  }): Promise<string> {
    const bare = await this.ensureSharedClone(args.url);
    const worktreePath = join(projectStorageDir(this.home, args.projectId), 'workspace');
    // Worktree path mustn't already exist (git worktree add refuses).
    // The Phase-1+2 invariant is that workspace/ is empty for fresh
    // github-linked projects (createProject skips bootstrap); for older
    // projects the migration moved gh/* into workspace/ so the dir is
    // already a checkout — we should NOT call worktree add in that case.
    // Caller should check existence first; here we surface a clear
    // error if it's already populated.
    try {
      const s = await stat(worktreePath);
      if (s.isDirectory()) {
        const entries = await readdir(worktreePath);
        if (entries.length > 0) {
          throw new Error(
            `Cannot create worktree at ${worktreePath}: directory is not empty (${entries.length} entries). Remove existing content or call addProjectWorktree before any files land in the workspace.`,
          );
        }
        // Empty dir — remove it so `git worktree add` can land cleanly.
        await rm(worktreePath, { recursive: true, force: true });
      }
    } catch (err) {
      // No-op if the dir doesn't exist (ENOENT).
      if (
        (err as { code?: string }).code !== 'ENOENT' &&
        !(err instanceof Error && err.message.includes('Cannot create worktree'))
      ) {
        // best-effort
      }
      if (err instanceof Error && err.message.includes('Cannot create worktree')) {
        throw err;
      }
    }
    const ref = args.ref ?? 'HEAD';
    await worktreeAdd(bare, worktreePath, ref);
    return worktreePath;
  }

  /**
   * Sweep `~/.gezel/git-clones/` for bare clones that no project
   * currently references, and delete the ones with no remaining
   * worktrees. Reactive cleanup runs as part of
   * `removeProjectWorktree`; this sweep is the safety net that
   * catches orphans missed by reactive cleanup (e.g. a crash
   * mid-unlink, an old install upgrading into Phase 3, manual
   * project.json edits).
   *
   * Safe to call any time — bare clones with active worktrees are
   * never touched, and the set of "referenced" keys is the union
   * across all current projects' `github.url` values.
   */
  async garbageCollectSharedClones(): Promise<{ removed: number; kept: number }> {
    const root = sharedClonesRoot(this.home);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return { removed: 0, kept: 0 };
    }
    const projects = await this.store.listProjects();
    const referenced = new Set<string>();
    for (const p of projects) {
      const url = p.github?.url;
      if (!url) continue;
      const key = sharedCloneKey(url);
      if (key) referenced.add(key);
    }
    let removed = 0;
    let kept = 0;
    for (const name of entries) {
      const bareDir = join(root, name);
      try {
        const s = await stat(bareDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      if (referenced.has(name)) {
        kept++;
        continue;
      }
      // Not referenced — safe to delete IFF no worktrees remain. If
      // worktrees exist (probably under user-managed dirs we don't
      // know about), leave alone.
      try {
        const worktrees = await worktreeList(bareDir);
        if (worktrees.length > 0) {
          kept++;
          continue;
        }
      } catch {
        // Bare clone may be corrupted — log + skip.
        kept++;
        continue;
      }
      try {
        await rm(bareDir, { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort
      }
    }
    return { removed, kept };
  }

  /**
   * Remove a project's worktree from the shared bare clone and, when
   * the bare clone has no more worktrees, delete the bare clone too.
   * Called from `Store.deleteProject` for github-linked projects in
   * shared-clone mode.
   */
  async removeProjectWorktree(args: {
    projectId: string;
    url: string;
    force?: boolean;
  }): Promise<void> {
    const key = sharedCloneKey(args.url);
    if (!key) return;
    const bare = sharedCloneDir(this.home, key);
    try {
      await stat(bare);
    } catch {
      return; // bare clone is already gone
    }
    const worktreePath = join(projectStorageDir(this.home, args.projectId), 'workspace');
    try {
      await worktreeRemove(bare, worktreePath, { force: args.force ?? false });
    } catch (err) {
      // Couldn't unregister cleanly — the worktree dir may already be
      // gone, or it may have uncommitted changes. The caller can pass
      // force: true to ignore. Either way, don't block the delete.
      if (!args.force) throw err;
    }
    // Ref-count: any remaining worktrees? If not, delete the bare.
    try {
      const remaining = await worktreeList(bare);
      if (remaining.length === 0) {
        await rm(bare, { recursive: true, force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Pick where the checkout should live. Order:
   *   1. If the project has a workingDir AND that dir is itself a git repo
   *      whose `origin` matches the configured URL, use it as-is.
   *   2. Else if the project has a workingDir, use `<workingDir>/gh/`.
   *   3. Else use the project's internal workspace directly — the clone
   *      IS the workspace from the model's perspective. Phase 2 of the
   *      workspace-fs unification: rather than cloning into a sibling
   *      `gh/` directory and exposing both an empty `workspace/` and a
   *      populated `gh/`, we land the clone at the workspace root so
   *      `readFile('package.json')` sees the repo's package.json. The
   *      legacy `projectInternalGithubDir` (`gh/` sibling) path is
   *      adopted only by the `cleanStaleWorkspaceBootstraps` migration
   *      so existing projects pre-Phase-2 don't drop their clone.
   */
  async resolveCheckout(project: ProjectDetail): Promise<CheckoutResolution> {
    const link = project.github;
    if (!link) throw new NoGitHubLinkError(project.id);
    if (project.workingDir) {
      const wdRepo = await inspectGitWorkdir(project.workingDir);
      if (wdRepo.isRepo && wdRepo.originUrl && sameGitHubRepo(wdRepo.originUrl, link.url)) {
        return {
          dir: project.workingDir,
          exists: true,
          originMatches: true,
          isAtWorkingDir: true,
        };
      }
      const inSub = join(project.workingDir, 'gh');
      const subRepo = await inspectGitWorkdir(inSub);
      return {
        dir: inSub,
        exists: subRepo.isRepo,
        originMatches: subRepo.originUrl ? sameGitHubRepo(subRepo.originUrl, link.url) : false,
        isAtWorkingDir: false,
      };
    }
    // No workingDir: clone directly into the workspace. If a legacy
    // `gh/` clone exists from before Phase 2 (no workspace clone yet),
    // adopt it so we don't re-clone — the migration in
    // `Store.cleanStaleWorkspaceBootstraps` will move it later.
    const workspace = join(projectStorageDir(this.home, project.id), 'workspace');
    const wsRepo = await inspectGitWorkdir(workspace);
    if (wsRepo.isRepo) {
      return {
        dir: workspace,
        exists: true,
        originMatches: wsRepo.originUrl ? sameGitHubRepo(wsRepo.originUrl, link.url) : false,
        isAtWorkingDir: false,
      };
    }
    const legacy = projectInternalGithubDir(this.home, project.id);
    const legacyRepo = await inspectGitWorkdir(legacy);
    if (legacyRepo.isRepo) {
      return {
        dir: legacy,
        exists: true,
        originMatches: legacyRepo.originUrl
          ? sameGitHubRepo(legacyRepo.originUrl, link.url)
          : false,
        isAtWorkingDir: false,
      };
    }
    // Neither exists — clone fresh into the workspace.
    return {
      dir: workspace,
      exists: false,
      originMatches: false,
      isAtWorkingDir: false,
    };
  }

  /**
   * Make sure a checkout exists. Idempotent: if the resolved dir already
   * has the right origin, returns immediately. Otherwise clones (creating
   * the parent dir as needed). Adoption of an existing matching repo is
   * recorded in the response for the caller (UI/history) to surface.
   */
  async ensureClone(project: ProjectDetail): Promise<{
    checkoutDir: string;
    branch?: string;
    adopted: boolean;
  }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (resolved.exists && resolved.originMatches) {
        const branch = await this.currentBranch(resolved.dir);
        await this.persistCheckoutDir(project, resolved.dir);
        return { checkoutDir: resolved.dir, branch, adopted: true };
      }
      if (resolved.exists && !resolved.originMatches) {
        // Don't blow away an existing repo with a different origin —
        // surface as an error so the user can decide what to do.
        throw new Error(
          `Refusing to clone over existing git repo at ${resolved.dir}: its origin does not match ${project.github!.url}`,
        );
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      const parsed = parseGitHubUrl(project.github!.url);
      if (!parsed) throw new Error(`Could not parse GitHub URL: ${project.github!.url}`);
      const pat = await this.getToken();
      const cloneUrl = authenticatedCloneUrl(parsed.cloneUrl, pat);
      await mkdir(resolved.dir, { recursive: true });
      const args = ['clone'];
      if (project.github!.branch) args.push('--branch', project.github!.branch);
      args.push(cloneUrl, resolved.dir);
      await runGit(args, { redact: pat ? [pat] : [] });
      // Strip any embedded PAT from the persisted remote so a re-fetch
      // through `git fetch origin` doesn't surface it from `.git/config`.
      if (pat) {
        await runGit(['remote', 'set-url', 'origin', parsed.cloneUrl], { cwd: resolved.dir });
      }
      const branch = await this.currentBranch(resolved.dir);
      await this.persistCheckoutDir(project, resolved.dir, branch);
      return { checkoutDir: resolved.dir, branch, adopted: false };
    });
  }

  /**
   * Fetch + fast-forward pull on the currently-checked-out branch. Uses the
   * stored PAT for auth via a one-shot `-c http.extraheader` rather than
   * rewriting the remote URL — keeps `.git/config` clean.
   */
  async pull(project: ProjectDetail): Promise<{ branch?: string; updated: boolean }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      const { baseArgs, redact } = await this.patArgs();
      const before = await this.headSha(resolved.dir);
      await runGit([...baseArgs, 'pull', '--ff-only'], {
        cwd: resolved.dir,
        redact,
      });
      const after = await this.headSha(resolved.dir);
      const branch = await this.currentBranch(resolved.dir);
      await this.persistCheckoutDir(project, resolved.dir, branch);
      return { branch, updated: before !== after };
    });
  }

  /**
   * Switch local branches. By default fetches first so a remote-only ref
   * is reachable, then `git checkout <branch>`. Pass `create: true` to
   * branch from current HEAD with `git checkout -b` (skips the fetch
   * since we're creating, not switching to a remote ref).
   */
  async checkoutBranch(
    project: ProjectDetail,
    branch: string,
    opts: { create?: boolean } = {},
  ): Promise<{ branch: string }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) throw new Error(`No checkout exists for project ${project.id}.`);
      if (opts.create) {
        await runGit(['checkout', '-b', branch], { cwd: resolved.dir });
        const current = (await this.currentBranch(resolved.dir)) ?? branch;
        await this.persistCheckoutDir(project, resolved.dir, current);
        return { branch: current };
      }
      const { baseArgs, redact } = await this.patArgs();
      // Fetch quietly so a remote-only branch is reachable.
      await runGit([...baseArgs, 'fetch', '--quiet', 'origin'], {
        cwd: resolved.dir,
        redact,
      });
      try {
        await runGit(['checkout', branch], { cwd: resolved.dir });
      } catch (err) {
        if (err instanceof GitError) {
          // Try as remote-tracking.
          await runGit(['checkout', '-B', branch, `origin/${branch}`], { cwd: resolved.dir });
        } else {
          throw err;
        }
      }
      const current = (await this.currentBranch(resolved.dir)) ?? branch;
      await this.persistCheckoutDir(project, resolved.dir, current);
      return { branch: current };
    });
  }

  /**
   * Local + remote branches present in the checkout. Strips the
   * `origin/` prefix from remotes and dedupes against the local list so
   * the UI can render two groups without double-counting branches that
   * have a tracking pair. `current` is whatever HEAD points at, or
   * undefined in detached HEAD.
   */
  async listBranches(
    project: ProjectDetail,
  ): Promise<{ local: string[]; remote: string[]; current?: string }> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) {
      throw new Error(`No checkout exists for project ${project.id}; clone first.`);
    }
    const { stdout } = await runGit(['branch', '-a', '--format=%(refname:short)'], {
      cwd: resolved.dir,
    });
    const lines = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const local = new Set<string>();
    const remote = new Set<string>();
    for (const line of lines) {
      if (line.startsWith('origin/')) {
        const name = line.slice('origin/'.length);
        if (name === 'HEAD' || /^HEAD ->/.test(name)) continue;
        remote.add(name);
      } else if (!line.includes('/')) {
        local.add(line);
      }
    }
    for (const b of local) remote.delete(b);
    const current = await this.currentBranch(resolved.dir);
    return {
      local: [...local].sort(),
      remote: [...remote].sort(),
      ...(current ? { current } : {}),
    };
  }

  /**
   * `git fetch origin` without merging. Surfaces upstream changes in
   * `status.ahead/behind` without touching the working tree. Same PAT-
   * via-extraheader injection `pull` uses.
   */
  async fetch(project: ProjectDetail): Promise<{ fetched: boolean }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      const { baseArgs, redact } = await this.patArgs();
      await this.ensureFetchRefspec(resolved.dir);
      let result: Awaited<ReturnType<typeof runGit>>;
      try {
        result = await runGit([...baseArgs, 'fetch', 'origin'], {
          cwd: resolved.dir,
          redact,
        });
      } catch (err) {
        if (this.classifyFetchError(err).state === 'auth') throw new MissingPatError();
        throw err;
      }
      const { stdout, stderr } = result;
      // `git fetch` reports advanced refs on stderr; empty means
      // already-up-to-date. Stdout is usually empty either way.
      const fetched = stderr.trim().length > 0 || stdout.trim().length > 0;
      await this.persistCheckoutDir(project, resolved.dir);
      return { fetched };
    });
  }

  /**
   * Stage everything and create a commit. `user.name` / `user.email`
   * are inferred from the signed-in GitHub identity when available, or
   * fall back to a `gezel-bot` shape so the operation always succeeds
   * even on a fresh install with no identity yet.
   */
  async commit(
    project: ProjectDetail,
    opts: { message: string; allowEmpty?: boolean },
  ): Promise<{ sha: string; filesChanged: number }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      // Stage all tracked + untracked changes. `add -A` is the equivalent
      // of staging deletions + new files + modifications in one shot —
      // matches the v1 "Save changes" UX which is whole-tree.
      await runGit(['add', '-A'], { cwd: resolved.dir });
      if (!opts.allowEmpty) {
        const dirty = await this.isDirty(resolved.dir).catch(() => true);
        if (!dirty) {
          throw new Error('No changes to commit.');
        }
      }
      const { name, email } = await this.resolveCommitIdentity();
      // Per-commit identity via `-c` flags — keeps the global config
      // untouched, important if the user is also using this checkout
      // from a separate git client.
      const idArgs = ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
      const commitArgs = [...idArgs, 'commit', '-m', opts.message];
      if (opts.allowEmpty) commitArgs.push('--allow-empty');
      await runGit(commitArgs, { cwd: resolved.dir });
      const sha = (await this.headSha(resolved.dir)) ?? '';
      // Count files in the new commit so the UI can echo "3 files saved".
      const { stdout } = await runGit(['show', '--name-only', '--format=', sha], {
        cwd: resolved.dir,
      }).catch(() => ({ stdout: '' }) as { stdout: string });
      const filesChanged = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
      return { sha, filesChanged };
    });
  }

  /**
   * Push the current branch to origin. We distinguish the common
   * rejection modes the user can act on:
   *   - non-fast-forward: remote moved on; "Sync first" is the fix
   *   - auth: PAT missing or revoked; re-sign-in
   *   - unknown: anything else (network, hook, etc.) — surface raw msg
   */
  async push(
    project: ProjectDetail,
  ): Promise<{ pushed: boolean; rejected?: 'non-fast-forward' | 'auth' | 'unknown' }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      return this.pushDir(resolved.dir);
    });
  }

  /**
   * Core push, given a resolved checkout dir. Lock-free so `sync` (which
   * already holds the project lock) can reuse it — `withLock` chains on
   * the held promise, so a nested `push(project)` would deadlock.
   */
  private async pushDir(
    dir: string,
  ): Promise<{ pushed: boolean; rejected?: 'non-fast-forward' | 'auth' | 'unknown' }> {
    const branch = await this.currentBranch(dir);
    if (!branch) {
      throw new Error('Detached HEAD — check out a branch before pushing.');
    }
    const { baseArgs, redact } = await this.patArgs();
    try {
      await runGit([...baseArgs, 'push', '--set-upstream', 'origin', branch], {
        cwd: dir,
        redact,
      });
      return { pushed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      let rejected: 'non-fast-forward' | 'auth' | 'unknown' = 'unknown';
      if (msg.includes('non-fast-forward') || msg.includes('fetch first')) {
        rejected = 'non-fast-forward';
      } else if (
        msg.includes('authentication') ||
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('could not read username')
      ) {
        rejected = 'auth';
      }
      return { pushed: false, rejected };
    }
  }

  // ── changes / history (read + discard) ────────────────────────────

  /**
   * Working-tree changes vs the last save (HEAD), shaped for the
   * non-technical "Changes" list: staging is collapsed, renames are one
   * entry, untracked files read as "added". Per-file +/- stats come from
   * one numstat pass (tracked) or a direct read (untracked); stat
   * failures degrade to a list without counts rather than erroring —
   * partial clones need origin access to materialize blobs for diffs.
   */
  async listChanges(
    project: ProjectDetail,
  ): Promise<{ changes: GitWorkingChange[]; total: number; truncated: boolean }> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return { changes: [], total: 0, truncated: false };
    const dir = resolved.dir;
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
    const entries = parseStatusZ(stdout);
    const total = entries.length;
    const capped = entries.slice(0, MAX_CHANGE_ENTRIES);
    let stats = new Map<string, NumstatEntry>();
    try {
      const head = (await this.headExists(dir)) ? 'HEAD' : EMPTY_TREE_SHA;
      const { baseArgs, redact } = await this.patArgs();
      const numstat = await runGit([...baseArgs, 'diff', head, '--numstat', '-z', '-M'], {
        cwd: dir,
        redact,
      });
      stats = parseNumstatZ(numstat.stdout);
    } catch {
      // Offline against a partial clone etc. — list without stats.
    }
    const changes: GitWorkingChange[] = [];
    for (const entry of capped) {
      const change: GitWorkingChange = { path: entry.path, kind: entry.kind };
      if (entry.oldPath) change.oldPath = entry.oldPath;
      if (entry.untracked) {
        Object.assign(change, await this.statUntracked(dir, entry.path));
      } else {
        const s = stats.get(entry.path);
        if (s?.binary) change.binary = true;
        else if (s) {
          change.additions = s.additions;
          change.deletions = s.deletions;
        }
      }
      changes.push(change);
    }
    return { changes, total, truncated: total > capped.length };
  }

  /**
   * Unified diff of one changed file vs HEAD. Untracked files get a
   * synthesized all-added patch (NOT `git diff --no-index`, which exits 1
   * and `GitError` drops stdout). Binary files short-circuit with no text.
   */
  async fileDiff(project: ProjectDetail, relPath: string): Promise<GitFileDiffResponse> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) {
      throw new Error(`No checkout exists for project ${project.id}; clone first.`);
    }
    const dir = resolved.dir;
    this.assertSafeRelPath(dir, relPath);
    const { stdout: statusOut } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
    const entry = parseStatusZ(statusOut).find((e) => e.path === relPath);
    if (!entry) {
      // Unchanged (or already saved while the UI was stale) — empty diff.
      return { path: relPath, kind: 'modified', binary: false, truncated: false, diff: '' };
    }
    if (entry.untracked) {
      const abs = this.assertSafeRelPath(dir, relPath);
      const buf = await readFile(abs);
      if (sniffBinary(buf)) {
        return { path: relPath, kind: 'added', binary: true, truncated: false };
      }
      const content = buf.toString('utf8');
      const { text, truncated } = truncateDiff(createPatch(relPath, '', content));
      return {
        path: relPath,
        kind: 'added',
        binary: false,
        truncated,
        diff: text,
        additions: countLines(content),
        deletions: 0,
      };
    }
    const head = (await this.headExists(dir)) ? 'HEAD' : EMPTY_TREE_SHA;
    const { baseArgs, redact } = await this.patArgs();
    // Include the old path in the pathspec so rename detection still has
    // both sides to pair up.
    const pathspec = ['--', relPath, ...(entry.oldPath ? [entry.oldPath] : [])];
    const numstat = await runGit(
      [...baseArgs, 'diff', head, '--numstat', '-z', '-M', ...pathspec],
      { cwd: dir, redact },
    );
    const stat = parseNumstatZ(numstat.stdout).get(relPath);
    if (stat?.binary) {
      return {
        path: relPath,
        kind: entry.kind,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        binary: true,
        truncated: false,
      };
    }
    const diffOut = await runGit([...baseArgs, 'diff', head, '-M', ...pathspec], {
      cwd: dir,
      redact,
    });
    const { text, truncated } = truncateDiff(diffOut.stdout);
    return {
      path: relPath,
      kind: entry.kind,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      binary: false,
      truncated,
      diff: text,
      ...(stat?.additions !== undefined ? { additions: stat.additions } : {}),
      ...(stat?.deletions !== undefined ? { deletions: stat.deletions } : {}),
    };
  }

  /**
   * Whole-tree diff + changed paths, shaped as AI input for the save-
   * description suggestion. `git diff HEAD` misses untracked files, so
   * small text ones get synthesized patches appended — brand-new work
   * (the common case for agent-created files) still yields a useful
   * suggestion.
   */
  async workingDiff(project: ProjectDetail): Promise<{ diff: string; changedPaths: string[] }> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return { diff: '', changedPaths: [] };
    const dir = resolved.dir;
    const { stdout: statusOut } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
    const entries = parseStatusZ(statusOut);
    const changedPaths = entries.map((e) => e.path);
    let diff = '';
    try {
      const head = (await this.headExists(dir)) ? 'HEAD' : EMPTY_TREE_SHA;
      const { baseArgs, redact } = await this.patArgs();
      ({ stdout: diff } = await runGit([...baseArgs, 'diff', head, '-M'], { cwd: dir, redact }));
    } catch {
      // Offline against a partial clone — paths alone still help.
    }
    let appended = 0;
    for (const entry of entries) {
      if (!entry.untracked) continue;
      if (appended >= 10 || diff.length > 60_000) break;
      const abs = safeJoin(dir, entry.path);
      if (!abs) continue;
      try {
        const s = await stat(abs);
        if (!s.isFile() || s.size > 64_000) continue;
        const buf = await readFile(abs);
        if (sniffBinary(buf)) continue;
        diff += `\n${createPatch(entry.path, '', buf.toString('utf8'))}`;
        appended++;
      } catch {
        // Skip unreadable files.
      }
    }
    return { diff: truncateDiff(diff, 60_000).text, changedPaths };
  }

  // ── code-review snapshots ──────────────────────────────────────────

  /**
   * The repo's default branch: cached on the project link, else local
   * `origin/HEAD`, else one `ls-remote` round-trip (cached back into the
   * local ref), else an existence probe of origin/main + origin/master.
   * The result is persisted on `project.github.defaultBranch` so later
   * calls never touch the network.
   */
  async defaultBranch(project: ProjectDetail): Promise<string> {
    const cached = project.github?.defaultBranch;
    if (cached) return cached;
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) throw new NoDefaultBranchError();
    const dir = resolved.dir;
    let name: string | undefined;
    try {
      const { stdout } = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: dir });
      name = stdout.trim().replace(/^refs\/remotes\/origin\//, '') || undefined;
    } catch {
      // origin/HEAD not set locally (common for bare-clone worktrees).
    }
    if (!name) {
      try {
        const { baseArgs, redact } = await this.patArgs();
        const { stdout } = await runGit([...baseArgs, 'ls-remote', '--symref', 'origin', 'HEAD'], {
          cwd: dir,
          redact,
        });
        const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(stdout);
        if (m?.[1]) {
          name = m[1];
          await runGit(['remote', 'set-head', 'origin', name], { cwd: dir }).catch(() => {});
        }
      } catch {
        // Offline — fall through to the existence probe.
      }
    }
    if (!name) {
      for (const candidate of ['main', 'master']) {
        try {
          await runGit(['rev-parse', '-q', '--verify', `refs/remotes/origin/${candidate}`], {
            cwd: dir,
          });
          name = candidate;
          break;
        } catch {
          // Keep probing.
        }
      }
    }
    if (!name) throw new NoDefaultBranchError();
    await this.store.updateProjectGitHub(project.id, { defaultBranch: name }).catch(() => {});
    return name;
  }

  /**
   * Commit-review snapshot: the uncommitted working tree vs HEAD, as one
   * stable file list + unified diff. Locked so a concurrent save/discard
   * can't skew the list against the diff. Untracked text files get
   * synthesized all-added patches with review-grade caps.
   */
  async snapshotWorkingChanges(project: ProjectDetail): Promise<GitReviewSnapshot> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      const dir = resolved.dir;
      if (await this.isMergeInProgress(dir)) throw new MergeInProgressError();
      const { stdout: statusOut } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
      const entries = parseStatusZ(statusOut);
      if (entries.length === 0) {
        throw new NothingToReviewError('There are no unsaved changes to review.');
      }
      const notes: string[] = [];
      const total = entries.length;
      const capped = entries.slice(0, MAX_CHANGE_ENTRIES);
      const head = (await this.headExists(dir)) ? 'HEAD' : EMPTY_TREE_SHA;
      const { baseArgs, redact } = await this.patArgs();
      let stats = new Map<string, NumstatEntry>();
      try {
        const numstat = await runGit([...baseArgs, 'diff', head, '--numstat', '-z', '-M'], {
          cwd: dir,
          redact,
        });
        stats = parseNumstatZ(numstat.stdout);
      } catch {
        notes.push('Per-file +/- counts were unavailable (offline against a partial clone?).');
      }
      const files: GitWorkingChange[] = [];
      for (const entry of capped) {
        const change: GitWorkingChange = { path: entry.path, kind: entry.kind };
        if (entry.oldPath) change.oldPath = entry.oldPath;
        if (entry.untracked) {
          Object.assign(change, await this.statUntracked(dir, entry.path));
        } else {
          const s = stats.get(entry.path);
          if (s?.binary) change.binary = true;
          else if (s) {
            change.additions = s.additions;
            change.deletions = s.deletions;
          }
        }
        files.push(change);
      }
      let diff = '';
      try {
        ({ stdout: diff } = await runGit([...baseArgs, 'diff', head, '-M'], { cwd: dir, redact }));
      } catch {
        notes.push('The tracked-file diff was unavailable (offline against a partial clone?).');
      }
      let appended = 0;
      for (const entry of capped) {
        if (!entry.untracked) continue;
        if (appended >= 50 || diff.length > REVIEW_DIFF_MAX_CHARS) break;
        const abs = safeJoin(dir, entry.path);
        if (!abs) continue;
        try {
          const s = await stat(abs);
          if (!s.isFile() || s.size > 256_000) continue;
          const buf = await readFile(abs);
          if (sniffBinary(buf)) continue;
          diff += `\n${createPatch(entry.path, '', buf.toString('utf8'))}`;
          appended++;
        } catch {
          // Skip unreadable files.
        }
      }
      const truncatedDiff = truncateDiff(diff, REVIEW_DIFF_MAX_CHARS);
      if (files.some((f) => f.binary)) {
        notes.push(
          'Binary files are listed in the manifest with binary:true and excluded from changes.diff.',
        );
      }
      const branch = (await this.currentBranch(dir)) ?? '(detached)';
      const headSha = (await this.headSha(dir)) ?? EMPTY_TREE_SHA;
      return {
        kind: 'commit',
        branch,
        headSha,
        baseRef: 'HEAD',
        baseSha: headSha,
        files,
        totalFiles: total,
        filesTruncated: total > capped.length,
        diff: truncatedDiff.text,
        diffTruncated: truncatedDiff.truncated,
        notes,
      };
    });
  }

  /**
   * Branch-review snapshot: this branch's committed work vs the default
   * branch — merge-base three-dot diff plus the commit list, computed
   * entirely from local git (a best-effort fetch refreshes the base
   * first; offline is tolerated with a note).
   */
  async snapshotBranchDiff(project: ProjectDetail): Promise<GitReviewSnapshot> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      const dir = resolved.dir;
      const branch = await this.currentBranch(dir);
      if (!branch) throw new DetachedHeadError();
      const defaultBranch = await this.defaultBranch(project);
      if (branch === defaultBranch) {
        throw new NothingToReviewError(
          `You are on ${defaultBranch} — switch to a work branch to review it against ${defaultBranch}.`,
        );
      }
      const notes: string[] = [];
      const { baseArgs, redact } = await this.patArgs();
      await this.ensureFetchRefspec(dir);
      try {
        await runGit([...baseArgs, 'fetch', '--quiet', 'origin', defaultBranch], {
          cwd: dir,
          redact,
        });
      } catch {
        notes.push(
          `Could not refresh origin/${defaultBranch} (offline?) — comparing against the last-fetched state.`,
        );
      }
      const baseRef = `origin/${defaultBranch}`;
      try {
        await runGit(['rev-parse', '-q', '--verify', `refs/remotes/${baseRef}`], { cwd: dir });
      } catch {
        throw new NoDefaultBranchError();
      }
      const headSha = await this.headSha(dir);
      if (!headSha) throw new NothingToReviewError('This branch has no commits to review yet.');
      const { stdout: baseShaOut } = await runGit(['merge-base', 'HEAD', baseRef], { cwd: dir });
      const baseSha = baseShaOut.trim();
      const range = `${baseRef}...HEAD`;
      const nameStatus = await runGit([...baseArgs, 'diff', '--name-status', '-z', '-M', range], {
        cwd: dir,
        redact,
      });
      const kinds = classifyNameStatus(nameStatus.stdout);
      const numstat = await runGit([...baseArgs, 'diff', '--numstat', '-z', '-M', range], {
        cwd: dir,
        redact,
      });
      const stats = parseNumstatZ(numstat.stdout);
      const allPaths = [...kinds.keys()];
      const capped = allPaths.slice(0, MAX_CHANGE_ENTRIES);
      const files: GitWorkingChange[] = [];
      for (const path of capped) {
        const ns = kinds.get(path);
        const change: GitWorkingChange = { path, kind: ns?.kind ?? 'modified' };
        if (ns?.oldPath) change.oldPath = ns.oldPath;
        const s = stats.get(path);
        if (s?.binary) change.binary = true;
        else if (s) {
          change.additions = s.additions;
          change.deletions = s.deletions;
        }
        files.push(change);
      }
      const diffOut = await runGit([...baseArgs, 'diff', '-M', range], { cwd: dir, redact });
      const truncatedDiff = truncateDiff(diffOut.stdout, REVIEW_DIFF_MAX_CHARS);
      const COMMITS_CAP = 200;
      let commits: GitLogEntry[] = [];
      let commitsTruncated = false;
      try {
        const { stdout } = await runGit(
          [
            ...baseArgs,
            'log',
            `--max-count=${COMMITS_CAP + 1}`,
            '--date-order',
            `--format=${LOG_FORMAT}`,
            '--numstat',
            `${baseRef}..HEAD`,
          ],
          { cwd: dir, redact },
        );
        const parsed = parseLog(stdout);
        commitsTruncated = parsed.length > COMMITS_CAP;
        commits = parsed.slice(0, COMMITS_CAP).map(({ email, ...rest }) => ({
          ...rest,
          ...(email ? { email } : {}),
        }));
      } catch {
        notes.push('The commit list was unavailable — the diff is still complete.');
      }
      if (commits.length === 0 && truncatedDiff.text.trim().length === 0) {
        throw new NothingToReviewError(`This branch has nothing new compared to ${defaultBranch}.`);
      }
      if (files.some((f) => f.binary)) {
        notes.push(
          'Binary files are listed in the manifest with binary:true and excluded from changes.diff.',
        );
      }
      return {
        kind: 'pr',
        branch,
        headSha,
        baseRef,
        baseSha,
        files,
        totalFiles: allPaths.length,
        filesTruncated: allPaths.length > capped.length,
        diff: truncatedDiff.text,
        diffTruncated: truncatedDiff.truncated,
        commits,
        commitsTruncated,
        notes,
      };
    });
  }

  /**
   * Put files back to their last-saved state. Tracked files are restored
   * from HEAD; untracked files are deleted. `all` resets the whole tree
   * but never touches ignored files (no `clean -x` — `.env` and
   * `node_modules` survive). Refused mid-merge: discarding conflicted
   * files would corrupt the resolution flow.
   */
  async discardChanges(
    project: ProjectDetail,
    opts: { paths?: string[]; all?: boolean },
  ): Promise<{ discarded: number }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      const dir = resolved.dir;
      if (await this.isMergeInProgress(dir)) throw new MergeInProgressError();
      const headExists = await this.headExists(dir);
      if (opts.all) {
        const before = await this.workingState(dir);
        if (headExists) {
          await runGit(['reset', '--hard', 'HEAD'], { cwd: dir });
        } else {
          await runGit(['rm', '-r', '--cached', '-q', '.'], { cwd: dir }).catch(() => {});
        }
        await runGit(['clean', '-fd'], { cwd: dir });
        return { discarded: before.changesCount };
      }
      let discarded = 0;
      for (const p of opts.paths ?? []) {
        this.assertSafeRelPath(dir, p);
        try {
          if (!headExists) throw new GitError('unborn HEAD', 1, '');
          await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', p], {
            cwd: dir,
          });
        } catch {
          // Not in HEAD (new file): unstage if staged, then delete.
          await runGit(['rm', '--cached', '-q', '--', p], { cwd: dir }).catch(() => {});
          await runGit(['clean', '-f', '--', p], { cwd: dir }).catch(() => {});
        }
        discarded++;
      }
      return { discarded };
    });
  }

  /** Commit history for the Timeline view, newest first. */
  async log(
    project: ProjectDetail,
    opts: { limit?: number; skip?: number } = {},
  ): Promise<{ commits: GitLogEntry[]; hasMore: boolean }> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return { commits: [], hasMore: false };
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const skip = Math.max(0, opts.skip ?? 0);
    const { baseArgs, redact } = await this.patArgs();
    let stdout = '';
    try {
      ({ stdout } = await runGit(
        [
          ...baseArgs,
          'log',
          `--max-count=${limit + 1}`,
          `--skip=${skip}`,
          '--date-order',
          `--format=${LOG_FORMAT}`,
          '--numstat',
        ],
        { cwd: resolved.dir, redact },
      ));
    } catch (err) {
      if (
        err instanceof GitError &&
        /does not have any commits|bad default revision|unknown revision/i.test(err.stderr)
      ) {
        return { commits: [], hasMore: false };
      }
      throw err;
    }
    const parsed = parseLog(stdout);
    const hasMore = parsed.length > limit;
    return {
      commits: parsed.slice(0, limit).map(({ email, ...rest }) => ({
        ...rest,
        ...(email ? { email } : {}),
      })),
      hasMore,
    };
  }

  /** One commit with per-file stats and its full patch (truncated). */
  async commitDetail(project: ProjectDetail, sha: string): Promise<GitCommitDetailResponse> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) {
      throw new Error(`No checkout exists for project ${project.id}; clone first.`);
    }
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid commit id.');
    const dir = resolved.dir;
    const { baseArgs, redact } = await this.patArgs();
    const headerOut = await runGit(
      [...baseArgs, 'show', sha, '--numstat', `--format=${LOG_FORMAT}`],
      { cwd: dir, redact },
    );
    const entry = parseLog(headerOut.stdout)[0];
    if (!entry) throw new Error('Commit not found.');
    const bodyStart = headerOut.stdout.indexOf('\n');
    const files = bodyStart === -1 ? [] : parseNumstatLines(headerOut.stdout.slice(bodyStart + 1));
    // Note: for merge commits `git show` suppresses the combined diff, so
    // files/diff come back empty — the UI renders those as a sync point.
    const patchOut = await runGit([...baseArgs, 'show', sha, '--format=', '--patch', '-M'], {
      cwd: dir,
      redact,
    });
    const { text, truncated } = truncateDiff(patchOut.stdout);
    return {
      sha: entry.sha,
      shortSha: entry.shortSha,
      author: entry.author,
      date: entry.date,
      subject: entry.subject,
      files,
      ...(text ? { diff: text } : {}),
      truncated,
    };
  }

  // ── sync + merge state machine ─────────────────────────────────────

  /**
   * One-verb sync: fetch, integrate remote changes, push. Every expected
   * outcome returns a structured state instead of throwing so the UI can
   * switch on one field:
   *   - 'needs-save'  dirty tree; the UI prompts to save, then re-syncs
   *   - 'conflicts'   merge stopped on overlapping edits; the repo is left
   *                   mid-merge for the resolution flow (abandonMerge is
   *                   the escape hatch)
   *   - 'auth' / 'offline'  fetch or push could not reach GitHub
   *   - 'error'       anything else, with a human-readable message
   */
  async sync(project: ProjectDetail): Promise<GitSyncResponse> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) {
        throw new Error(`No checkout exists for project ${project.id}; clone first.`);
      }
      if (!(await isGitInstalled())) throw new GitNotInstalledError();
      const dir = resolved.dir;
      if (await this.isMergeInProgress(dir)) {
        // Also the app-restart recovery path: MERGE_HEAD survives on disk.
        return {
          state: 'conflicts',
          pulled: 0,
          pushed: 0,
          conflictedFiles: await this.conflictedPaths(dir),
        };
      }
      const working = await this.workingState(dir);
      if (working.dirty) return { state: 'needs-save', pulled: 0, pushed: 0 };
      const branch = await this.currentBranch(dir);
      if (!branch) {
        return {
          state: 'error',
          pulled: 0,
          pushed: 0,
          message: 'Not on a branch — switch to a branch to sync.',
        };
      }
      const { baseArgs, redact } = await this.patArgs();
      const { name, email } = await this.resolveCommitIdentity();
      const idArgs = ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
      await this.ensureFetchRefspec(dir);

      let pulled = 0;
      let pushed = 0;
      let merged = false;
      // Two passes: if the remote advances between our fetch and push
      // (push rejected non-fast-forward), refetch + reintegrate once.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await runGit([...baseArgs, 'fetch', 'origin'], { cwd: dir, redact });
        } catch (err) {
          return { ...this.classifyFetchError(err), pulled, pushed, branch };
        }
        const upstream = await this.resolveUpstreamRef(dir, branch);
        if (!upstream) {
          // Brand-new branch: nothing to receive — publish it.
          const toPush = await this.unpushedCount(dir);
          const res = await this.pushDir(dir);
          if (!res.pushed) return this.pushFailureToSync(res, { pulled, pushed, branch });
          pushed += toPush;
          await this.persistCheckoutDir(project, dir, branch);
          return { state: 'synced', pulled, pushed, branch };
        }
        const counts = (await this.aheadBehindRefs(dir, upstream)) ?? { ahead: 0, behind: 0 };
        if (counts.behind > 0) {
          if (counts.ahead === 0) {
            await runGit([...baseArgs, 'merge', '--ff-only', upstream], { cwd: dir, redact });
          } else {
            const mergeRes = await runGit(
              [
                ...idArgs,
                ...baseArgs,
                'merge',
                '-m',
                'Combined your changes with updates from GitHub',
                upstream,
              ],
              { cwd: dir, redact, acceptExitCodes: [1] },
            );
            if (mergeRes.code === 1) {
              if (await this.isMergeInProgress(dir)) {
                return {
                  state: 'conflicts',
                  pulled,
                  pushed,
                  branch,
                  conflictedFiles: await this.conflictedPaths(dir),
                };
              }
              // Merge refused outright (unrelated histories, fs error)
              // and self-aborted — nothing in progress to resolve.
              const detail = (mergeRes.stderr || mergeRes.stdout).trim();
              return {
                state: 'error',
                pulled,
                pushed,
                branch,
                message: detail || 'Could not combine your changes with the changes from GitHub.',
              };
            }
            merged = true;
          }
          pulled += counts.behind;
        }
        if (counts.ahead > 0 || merged) {
          const res = await this.pushDir(dir);
          if (!res.pushed) {
            if (res.rejected === 'non-fast-forward' && attempt === 0) continue;
            return this.pushFailureToSync(res, { pulled, pushed, branch });
          }
          pushed += counts.ahead + (merged ? 1 : 0);
        }
        await this.persistCheckoutDir(project, dir, branch);
        return { state: 'synced', pulled, pushed, branch, ...(merged ? { merged } : {}) };
      }
      return {
        state: 'error',
        pulled,
        pushed,
        branch,
        message: 'GitHub kept moving while we were syncing — try again in a moment.',
      };
    });
  }

  /** Whether a merge is waiting on resolution, and which files overlap. */
  async mergeState(
    project: ProjectDetail,
  ): Promise<{ inMerge: boolean; conflicts: GitConflictFile[] }> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return { inMerge: false, conflicts: [] };
    const dir = resolved.dir;
    if (!(await this.isMergeInProgress(dir))) return { inMerge: false, conflicts: [] };
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
    const conflicts = parseStatusZ(stdout)
      .filter((e) => e.kind === 'conflicted')
      .map((e) => ({ path: e.path, kind: conflictKindFromXY(e.xy) }));
    return { inMerge: true, conflicts };
  }

  /**
   * The three versions of a conflicted file from the index stages:
   * 1 = common ancestor, 2 = ours, 3 = theirs. Stages can legitimately
   * be missing (no base when both sides added; no theirs when GitHub
   * deleted) — those come back undefined, not as errors.
   */
  async conflictFileVersions(
    project: ProjectDetail,
    relPath: string,
  ): Promise<GitConflictVersionsResponse> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) throw new NotInMergeError();
    const dir = resolved.dir;
    if (!(await this.isMergeInProgress(dir))) throw new NotInMergeError();
    this.assertSafeRelPath(dir, relPath);
    const { baseArgs, redact } = await this.patArgs();
    const readStage = async (stage: number): Promise<string | undefined> => {
      try {
        const { stdout } = await runGit([...baseArgs, 'show', `:${stage}:${relPath}`], {
          cwd: dir,
          redact,
        });
        return stdout;
      } catch {
        return undefined;
      }
    };
    const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)]);
    const sides = [base, ours, theirs].filter((s): s is string => s !== undefined);
    const binary = sides.some((s) => s.includes('\0'));
    const tooLarge = sides.some((s) => s.length > MAX_CONFLICT_SIDE_CHARS);
    if (binary || tooLarge) return { path: relPath, binary, tooLarge };
    return {
      path: relPath,
      ...(base !== undefined ? { base } : {}),
      ...(ours !== undefined ? { ours } : {}),
      ...(theirs !== undefined ? { theirs } : {}),
      binary: false,
      tooLarge: false,
    };
  }

  /**
   * Settle one conflicted file: keep ours, keep theirs, or write custom
   * content (the AI-combined preview lands through `custom`). When the
   * chosen side deleted the file, resolution removes it.
   */
  async resolveConflictFile(
    project: ProjectDetail,
    relPath: string,
    resolution: { choice: 'mine' | 'theirs' | 'custom'; content?: string },
  ): Promise<{ remaining: number }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) throw new NotInMergeError();
      const dir = resolved.dir;
      if (!(await this.isMergeInProgress(dir))) throw new NotInMergeError();
      const abs = this.assertSafeRelPath(dir, relPath);
      // Only files still carrying unmerged index stages can be resolved —
      // re-resolving a settled path would mis-fire the deletion fallback.
      const stages = await this.unmergedStages(dir, relPath);
      if (stages.size === 0) {
        throw new Error(`${relPath} is already settled — cancel the sync to start over.`);
      }
      if (resolution.choice === 'custom') {
        await writeFile(abs, resolution.content ?? '', 'utf8');
        await runGit(['add', '--', relPath], { cwd: dir });
      } else {
        // Stage 2 = ours, stage 3 = theirs. A missing stage means that
        // side deleted the file, so keeping it resolves to removal.
        const stage = resolution.choice === 'mine' ? '2' : '3';
        if (stages.has(stage)) {
          const side = resolution.choice === 'mine' ? '--ours' : '--theirs';
          await runGit(['checkout', side, '--', relPath], { cwd: dir });
          await runGit(['add', '--', relPath], { cwd: dir });
        } else {
          await runGit(['rm', '--force', '-q', '--', relPath], { cwd: dir });
        }
      }
      const remaining = (await this.conflictedPaths(dir)).length;
      return { remaining };
    });
  }

  /** Commit the merge once every conflict is settled. */
  async completeMerge(
    project: ProjectDetail,
    opts: { message?: string } = {},
  ): Promise<{ sha: string }> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) throw new NotInMergeError();
      const dir = resolved.dir;
      if (!(await this.isMergeInProgress(dir))) throw new NotInMergeError();
      const remaining = await this.conflictedPaths(dir);
      if (remaining.length > 0) throw new ConflictsRemainError(remaining);
      const { name, email } = await this.resolveCommitIdentity();
      const idArgs = ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
      const message = opts.message?.trim();
      // Without an explicit message, `--no-edit` keeps the MERGE_MSG the
      // sync's `merge -m` already wrote.
      const args = message
        ? [...idArgs, 'commit', '-m', message]
        : [...idArgs, 'commit', '--no-edit'];
      await runGit(args, { cwd: dir });
      const sha = (await this.headSha(dir)) ?? '';
      return { sha };
    });
  }

  /**
   * Cancel an in-progress merge, restoring the exact pre-sync state.
   * Safe because `sync` only starts merges from a clean tree. No-op when
   * nothing is in progress.
   */
  async abandonMerge(project: ProjectDetail): Promise<void> {
    return this.withLock(project.id, async () => {
      const resolved = await this.resolveCheckout(project);
      if (!resolved.exists) return;
      if (await this.isMergeInProgress(resolved.dir)) {
        await runGit(['merge', '--abort'], { cwd: resolved.dir });
      }
    });
  }

  /**
   * Best-effort commit identity. Reads the GitHub OAuth identity off
   * config when present (gives "Ada <12345+ada@users.noreply.github.com>"
   * shape that maps to a real GitHub account). Falls back to a noreply
   * gezel-bot identity so commits never fail on a fresh install.
   */
  private async resolveCommitIdentity(): Promise<{ name: string; email: string }> {
    try {
      const cfg = await this.store.readConfig();
      const auth = cfg.githubAuth;
      if (auth?.kind === 'oauth' && auth.login) {
        const displayName =
          auth.name && auth.name.trim().length > 0 ? auth.name.trim() : auth.login;
        return {
          name: displayName,
          email: `${auth.login}@users.noreply.github.com`,
        };
      }
    } catch {
      /* fall through to default */
    }
    return { name: 'gezel-bot', email: 'noreply@gezel.local' };
  }

  async status(project: ProjectDetail): Promise<GitStatus> {
    const credentialSource = await this.credentialSource();
    const hasPat = credentialSource === 'pat';
    if (!project.github) return { exists: false, hasPat, credentialSource };
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) {
      return {
        github: project.github,
        exists: false,
        originMatches: resolved.originMatches,
        hasPat,
        credentialSource,
      };
    }
    const [branch, working, mergeInProgress] = await Promise.all([
      this.currentBranch(resolved.dir),
      this.workingState(resolved.dir).catch(() => undefined),
      this.isMergeInProgress(resolved.dir),
    ]);
    // Resolve the upstream the way sync does (configured upstream, else
    // origin/<branch>) so ahead/behind also works for worktree checkouts
    // that never had branch tracking configured.
    const upstreamRef = branch ? await this.resolveUpstreamRef(resolved.dir, branch) : undefined;
    const hasUpstream = upstreamRef !== undefined;
    const counts = upstreamRef ? await this.aheadBehindRefs(resolved.dir, upstreamRef) : undefined;
    return {
      github: project.github,
      exists: true,
      originMatches: resolved.originMatches,
      branch,
      ahead: counts?.ahead,
      behind: counts?.behind,
      dirty: working?.dirty,
      changesCount: working?.changesCount,
      conflictedCount: working?.conflictedCount,
      mergeInProgress,
      hasUpstream,
      hasPat,
      credentialSource,
    };
  }

  /** Recursive list of working-tree files (skipping .git and node_modules). */
  async listFiles(project: ProjectDetail): Promise<ProjectFileEntry[]> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return [];
    return walkDir(resolved.dir, MAX_FILES_RETURNED);
  }

  async readFile(project: ProjectDetail, relPath: string): Promise<string | null> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return null;
    const safe = safeJoin(resolved.dir, relPath);
    if (!safe) return null;
    try {
      return await readFile(safe, 'utf8');
    } catch {
      return null;
    }
  }

  /** Absolute path inside the checkout for a given relative path, or null if unsafe. */
  async resolveFilePath(project: ProjectDetail, relPath: string): Promise<string | null> {
    const resolved = await this.resolveCheckout(project);
    if (!resolved.exists) return null;
    return safeJoin(resolved.dir, relPath);
  }

  // ── git plumbing helpers ───────────────────────────────────────────

  private async currentBranch(dir: string): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
      const out = stdout.trim();
      return out === 'HEAD' ? undefined : out;
    } catch {
      return undefined;
    }
  }

  private async headSha(dir: string): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private async isDirty(dir: string): Promise<boolean> {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: dir });
    return stdout.trim().length > 0;
  }

  /**
   * Token auth (stored PAT or ambient gh/env credential) as one-shot
   * `-c http.extraheader` args + the matching redact list. Applied to
   * every command that can talk to origin — including diff/log/show/merge,
   * which lazily fetch blobs in partial clones.
   */
  private async patArgs(): Promise<{ baseArgs: string[]; redact: string[] }> {
    const pat = await this.getToken();
    if (!pat) return { baseArgs: [], redact: [] };
    // GitHub recommends `Bearer <token>`; extraheader keeps the token out
    // of remote URLs persisted in `.git/config` and off process args.
    return {
      baseArgs: ['-c', `http.extraheader=AUTHORIZATION: Bearer ${pat}`],
      redact: [pat],
    };
  }

  /**
   * Bare clones are created without a fetch refspec, so `git fetch`
   * never materializes `refs/remotes/origin/*` — which sync relies on
   * to see what GitHub has. Install the standard refspec when missing
   * (a no-op for normal clones, where this IS the default). Worktrees
   * write through to the shared bare config, so one call fixes every
   * checkout of that clone.
   */
  private async ensureFetchRefspec(dir: string): Promise<void> {
    try {
      await runGit(['config', '--get', 'remote.origin.fetch'], { cwd: dir });
    } catch {
      await runGit(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], {
        cwd: dir,
      }).catch(() => {
        // No origin remote at all — fetch will fail with its own error.
      });
    }
  }

  /** False only for an unborn HEAD (fresh repo with no commits yet). */
  private async headExists(dir: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: dir });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * MERGE_HEAD check via rev-parse, NOT an fs stat of `.git/MERGE_HEAD` —
   * worktree checkouts have a `.git` FILE pointing at the real gitdir.
   */
  private async isMergeInProgress(dir: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir });
      return true;
    } catch {
      return false;
    }
  }

  private async conflictedPaths(dir: string): Promise<string[]> {
    const { stdout } = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], {
      cwd: dir,
    });
    return stdout.split('\0').filter((p) => p.length > 0);
  }

  /** Unmerged index stages ('1'|'2'|'3') still present for one path. */
  private async unmergedStages(dir: string, relPath: string): Promise<Set<string>> {
    const { stdout } = await runGit(['ls-files', '-u', '-z', '--', relPath], { cwd: dir });
    const stages = new Set<string>();
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      // Format: "<mode> <sha> <stage>\t<path>"
      const meta = entry.split('\t')[0];
      const stage = meta?.split(/\s+/)[2];
      if (stage) stages.add(stage);
    }
    return stages;
  }

  /**
   * The ref to integrate from: the configured upstream when present,
   * else `origin/<branch>` when that exists. Undefined for a branch
   * GitHub has never seen (the publish-new-branch path).
   */
  private async resolveUpstreamRef(dir: string, branch: string): Promise<string | undefined> {
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd: dir },
      );
      const ref = stdout.trim();
      if (ref) return ref;
    } catch {
      // No upstream configured — fall through to the origin ref.
    }
    try {
      await runGit(['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`], {
        cwd: dir,
      });
      return `origin/${branch}`;
    } catch {
      return undefined;
    }
  }

  private async aheadBehindRefs(
    dir: string,
    upstream: string,
  ): Promise<{ ahead: number; behind: number } | undefined> {
    try {
      const { stdout } = await runGit(
        ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
        { cwd: dir },
      );
      const [aheadStr, behindStr] = stdout.trim().split(/\s+/);
      const ahead = Number.parseInt(aheadStr ?? '0', 10);
      const behind = Number.parseInt(behindStr ?? '0', 10);
      if (Number.isNaN(ahead) || Number.isNaN(behind)) return undefined;
      return { ahead, behind };
    } catch {
      return undefined;
    }
  }

  /** Commits on HEAD that exist on no origin ref (new-branch publish count). */
  private async unpushedCount(dir: string): Promise<number> {
    try {
      const { stdout } = await runGit(
        ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
        { cwd: dir },
      );
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /** One porcelain pass → dirty + change/conflict counts for status. */
  private async workingState(
    dir: string,
  ): Promise<{ dirty: boolean; changesCount: number; conflictedCount: number }> {
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: dir });
    const entries = parseStatusZ(stdout);
    return {
      dirty: entries.length > 0,
      changesCount: entries.length,
      conflictedCount: entries.filter((e) => e.kind === 'conflicted').length,
    };
  }

  /** Line stats for an untracked file; empty when binary/huge/unreadable. */
  private async statUntracked(
    dir: string,
    relPath: string,
  ): Promise<Pick<GitWorkingChange, 'additions' | 'deletions' | 'binary'>> {
    const abs = safeJoin(dir, relPath);
    if (!abs) return {};
    try {
      const s = await stat(abs);
      if (!s.isFile() || s.size > MAX_UNTRACKED_STAT_BYTES) return {};
      const buf = await readFile(abs);
      if (sniffBinary(buf)) return { binary: true };
      return { additions: countLines(buf.toString('utf8')), deletions: 0 };
    } catch {
      return {};
    }
  }

  /** Reject path traversal and option-injection (leading `-`) attempts. */
  private assertSafeRelPath(dir: string, relPath: string): string {
    const abs = relPath.startsWith('-') ? null : safeJoin(dir, relPath);
    if (!abs) throw new Error(`Invalid path: ${relPath}`);
    return abs;
  }

  private classifyFetchError(err: unknown): {
    state: 'auth' | 'offline' | 'error';
    message?: string;
  } {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.toLowerCase();
    if (
      msg.includes('authentication') ||
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('could not read username')
    ) {
      return { state: 'auth' };
    }
    if (
      msg.includes('could not resolve host') ||
      msg.includes('unable to access') ||
      msg.includes('connection timed') ||
      msg.includes('network is unreachable') ||
      msg.includes('connection refused') ||
      msg.includes('timed out')
    ) {
      return { state: 'offline' };
    }
    return { state: 'error', message: raw };
  }

  private pushFailureToSync(
    res: { rejected?: 'non-fast-forward' | 'auth' | 'unknown' },
    partial: { pulled: number; pushed: number; branch: string },
  ): GitSyncResponse {
    if (res.rejected === 'auth') return { state: 'auth', ...partial };
    return {
      state: 'error',
      ...partial,
      message:
        res.rejected === 'non-fast-forward'
          ? 'GitHub kept moving while we were syncing — try again in a moment.'
          : 'GitHub did not accept the changes. Try again in a moment.',
    };
  }

  private async persistCheckoutDir(
    project: ProjectDetail,
    checkoutDir: string,
    branch?: string,
  ): Promise<void> {
    const next: Partial<ProjectGitHub> = {
      checkoutDir,
      lastSyncedAt: new Date().toISOString(),
    };
    if (branch) next.branch = branch;
    await this.store.updateProjectGitHub(project.id, next);
  }

  private async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId);
    const next = (prev ?? Promise.resolve()).then(fn, fn);
    // Store a settled-safe tail: callers still see `next` reject, but the
    // copy held in the map never does — otherwise every failing operation
    // surfaces a second, unhandled rejection from the lock chain.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }
}

// ── module-private helpers ───────────────────────────────────────────

/**
 * Porcelain XY → user-facing conflict kind. AU/UA fold into both-added
 * (one side's add is all that exists); DD folds into deleted-by-them
 * (either resolution deletes the file, so the distinction is moot).
 */
function conflictKindFromXY(xy: string): GitConflictKind {
  switch (xy) {
    case 'UU':
      return 'both-modified';
    case 'DU':
      return 'deleted-by-us';
    case 'UD':
    case 'DD':
      return 'deleted-by-them';
    default:
      return 'both-added';
  }
}

async function walkDir(root: string, cap: number): Promise<ProjectFileEntry[]> {
  const out: ProjectFileEntry[] = [];
  await walk('', root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;

  async function walk(rel: string, abs: string): Promise<void> {
    if (out.length >= cap) return;
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= cap) return;
      if (SKIP_DIR_NAMES.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(childAbs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        out.push({ name, path: childRel, isDirectory: true });
        await walk(childRel, childAbs);
      } else if (s.isFile()) {
        out.push({ name, path: childRel, isDirectory: false });
      }
    }
  }
}
