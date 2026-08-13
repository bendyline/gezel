import type {
  GitHubPullComment,
  GitHubPullDetail,
  GitHubPullFile,
  GitHubPullSummary,
  ProjectDetail,
} from '@bendyline/gezel';
import { Octokit } from '@octokit/rest';
import { MissingPatError, NoGitHubLinkError } from '../git/manager.js';
import type { GitManager } from '../git/manager.js';
import { parseGitHubUrl } from './url.js';

/**
 * GitHub REST queries used by the UI to render the PR list/detail panels.
 * Authenticates with the same credential chain the GitManager uses for
 * clones — stored toolset PAT, GH_TOKEN/GITHUB_TOKEN env vars, or the
 * signed-in GitHub CLI — so a `gh auth login` user configures nothing.
 */

const REVIEW_PATCH_LIMIT = 8_000;
const REVIEW_FILE_PAGE_LIMIT = 100;
const REVIEW_DIFF_PAGE_LIMIT = 48_000;

export interface GitHubPullFilesPage {
  files: GitHubPullFile[];
  allFiles: number;
  totalFiles: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  includesPatch: boolean;
}

export interface GitHubPullDiffPage {
  diff: string;
  path?: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  truncated: boolean;
  nextOffset?: number;
}

export class GitHubPrs {
  constructor(private readonly manager: GitManager) {}

  private async client(): Promise<Octokit> {
    const token = await this.manager.getToken();
    if (!token) throw new MissingPatError();
    return new Octokit({
      auth: token,
      userAgent: 'gezel/0.0.0',
    });
  }

  private repoOf(project: ProjectDetail): { owner: string; repo: string } {
    if (!project.github) throw new NoGitHubLinkError(project.id);
    const parsed = parseGitHubUrl(project.github.url);
    if (!parsed) throw new Error(`Could not parse GitHub URL: ${project.github.url}`);
    return { owner: parsed.owner, repo: parsed.repo };
  }

  async listPullRequests(project: ProjectDetail): Promise<GitHubPullSummary[]> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    });
    return res.data.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? '?',
      headRef: p.head.ref,
      baseRef: p.base.ref,
      draft: Boolean(p.draft),
      updatedAt: p.updated_at,
      url: p.html_url,
    }));
  }

  async getPullRequest(project: ProjectDetail, num: number): Promise<GitHubPullDetail> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const { data: p } = await octo.pulls.get({ owner, repo, pull_number: num });
    return {
      number: p.number,
      title: p.title,
      author: p.user?.login ?? '?',
      headRef: p.head.ref,
      baseRef: p.base.ref,
      draft: Boolean(p.draft),
      updatedAt: p.updated_at,
      url: p.html_url,
      body: p.body ?? '',
      state: p.state,
      merged: Boolean(p.merged),
      mergeable: p.mergeable ?? null,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changed_files,
    };
  }

  /**
   * `patchLimit` exists for the connector, which mirrors patches to disk
   * rather than into a tool result: a file the model will open must not be
   * silently clipped mid-hunk. Tool callers keep the default budget.
   */
  async listFiles(
    project: ProjectDetail,
    num: number,
    opts?: { patchLimit?: number; includePatch?: boolean },
  ): Promise<GitHubPullFile[]> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const limit = opts?.patchLimit ?? REVIEW_PATCH_LIMIT;
    const res = await octo.paginate(octo.pulls.listFiles, {
      owner,
      repo,
      pull_number: num,
      per_page: 100,
    });
    const includePatch = opts?.includePatch !== false;
    return res.map((f) => {
      const patch = f.patch && includePatch ? truncateWithMeta(f.patch, limit) : null;
      return {
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        ...(patch
          ? {
              patch: patch.text,
              patchChars: patch.totalChars,
              patchTruncated: patch.truncated,
            }
          : {}),
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
      };
    });
  }

  /**
   * A bounded, explicitly paginated view for API/tool consumers. Metadata is
   * complete for the selected page before any optional patch bodies appear,
   * so a bridge cap can no longer erase the existence of later files.
   */
  async listFilesPage(
    project: ProjectDetail,
    num: number,
    opts: {
      offset?: number;
      limit?: number;
      paths?: readonly string[];
      includePatch?: boolean;
      patchLimit?: number;
    } = {},
  ): Promise<GitHubPullFilesPage> {
    const includePatch = opts.includePatch === true;
    const all = await this.listFiles(project, num, {
      includePatch,
      patchLimit: opts.patchLimit ?? REVIEW_PATCH_LIMIT,
    });
    const wanted = new Set((opts.paths ?? []).map((path) => path.trim()).filter(Boolean));
    const selected = wanted.size > 0 ? all.filter((file) => wanted.has(file.filename)) : all;
    const offset = clampInteger(opts.offset, 0, selected.length, 0);
    const limit = clampInteger(opts.limit, 1, 200, REVIEW_FILE_PAGE_LIMIT);
    const files = selected.slice(offset, offset + limit);
    const nextOffset = offset + files.length;
    const hasMore = nextOffset < selected.length;
    return {
      files,
      allFiles: all.length,
      totalFiles: selected.length,
      offset,
      limit,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      includesPatch: includePatch,
    };
  }

  async listComments(project: ProjectDetail, num: number): Promise<GitHubPullComment[]> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const [issueComments, reviewComments] = await Promise.all([
      octo.issues.listComments({ owner, repo, issue_number: num, per_page: 100 }),
      octo.pulls.listReviewComments({ owner, repo, pull_number: num, per_page: 100 }),
    ]);
    const merged: GitHubPullComment[] = [
      ...issueComments.data.map((c) => ({
        id: c.id,
        author: c.user?.login ?? '?',
        body: c.body ?? '',
        createdAt: c.created_at,
        kind: 'issue' as const,
      })),
      ...reviewComments.data.map((c) => ({
        id: c.id,
        author: c.user?.login ?? '?',
        body: c.body ?? '',
        createdAt: c.created_at,
        kind: 'review' as const,
        ...(c.path ? { path: c.path } : {}),
      })),
    ];
    merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return merged;
  }

  /**
   * Fetch the unified diff for a PR via the `application/vnd.github.v3.diff`
   * Accept header. GitHub returns the entire diff as text — useful for
   * craftbooks that want to feed the diff body to the model rather than
   * iterate per-file. Truncated at a generous limit so a 50K-line PR
   * doesn't blow out the context.
   */
  async getPullRequestDiff(
    project: ProjectDetail,
    num: number,
    opts?: { limit?: number },
  ): Promise<string> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: num,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return truncate(body, opts?.limit ?? REVIEW_PATCH_LIMIT * 8);
  }

  /** Bounded diff page with machine-readable continuation metadata. */
  async getPullRequestDiffPage(
    project: ProjectDetail,
    num: number,
    opts: { offset?: number; limit?: number; path?: string } = {},
  ): Promise<GitHubPullDiffPage> {
    const full = await this.getPullRequestDiff(project, num, { limit: Number.POSITIVE_INFINITY });
    const path = opts.path?.trim();
    const selected = path ? filterUnifiedDiffByPath(full, path) : full;
    if (path && selected.length === 0) {
      throw new Error(`Changed path not found in pull request #${num}: ${path}`);
    }
    const page = sliceTextPage(selected, opts.offset, opts.limit);
    return { ...page, ...(path ? { path } : {}) };
  }

  /**
   * Post a top-level (issue-style) comment to a PR. Returns the new
   * comment id + URL so callers can link the user/model to it.
   */
  async createComment(
    project: ProjectDetail,
    num: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.issues.createComment({ owner, repo, issue_number: num, body });
    return { id: res.data.id, url: res.data.html_url };
  }

  /**
   * Open a new pull request against the project's GitHub repo. `head`
   * accepts either a branch name (assumed in the same repo) or
   * `owner:branch` for cross-fork PRs.
   */
  async createPullRequest(
    project: ProjectDetail,
    args: { title: string; body?: string; head: string; base: string; draft?: boolean },
  ): Promise<{ number: number; url: string }> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.pulls.create({
      owner,
      repo,
      title: args.title,
      head: args.head,
      base: args.base,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.draft !== undefined ? { draft: args.draft } : {}),
    });
    return { number: res.data.number, url: res.data.html_url };
  }

  /**
   * Recent CI workflow runs for a branch. Used by `/ship` craftbook to
   * wait for checks before merging.
   */
  async listWorkflowRuns(
    project: ProjectDetail,
    branch: string,
    limit = 10,
  ): Promise<
    Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      createdAt: string;
      url: string;
    }>
  > {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      branch,
      per_page: Math.min(limit, 100),
    });
    return res.data.workflow_runs.map((r) => ({
      id: r.id,
      name: r.name ?? '?',
      status: r.status ?? 'unknown',
      conclusion: r.conclusion,
      createdAt: r.created_at,
      url: r.html_url,
    }));
  }

  /**
   * Combined check status for a ref (branch or sha). Returns the
   * highest-level pass/fail summary plus individual check details.
   */
  async getCheckStatus(
    project: ProjectDetail,
    ref: string,
  ): Promise<{
    state: 'success' | 'failure' | 'pending' | 'unknown';
    checks: Array<{ name: string; status: string; conclusion: string | null; url?: string }>;
  }> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const runs = await octo.checks.listForRef({ owner, repo, ref, per_page: 100 });
    const checks = runs.data.check_runs.map((c) => ({
      name: c.name,
      status: c.status ?? 'unknown',
      conclusion: c.conclusion,
      ...(c.html_url ? { url: c.html_url } : {}),
    }));
    if (checks.length === 0) {
      return { state: 'unknown', checks };
    }
    const anyPending = checks.some((c) => c.status !== 'completed');
    if (anyPending) return { state: 'pending', checks };
    const anyFailure = checks.some(
      (c) =>
        c.conclusion === 'failure' ||
        c.conclusion === 'cancelled' ||
        c.conclusion === 'timed_out' ||
        c.conclusion === 'action_required',
    );
    return { state: anyFailure ? 'failure' : 'success', checks };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)`;
}

function truncateWithMeta(
  text: string,
  max: number,
): { text: string; totalChars: number; truncated: boolean } {
  if (!Number.isFinite(max) || text.length <= max) {
    return { text, totalChars: text.length, truncated: false };
  }
  return {
    text: text.slice(0, Math.max(0, max)),
    totalChars: text.length,
    truncated: true,
  };
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** Pure helper exported for the pagination regression tests. */
export function sliceTextPage(
  text: string,
  offsetInput?: number,
  limitInput?: number,
): Omit<GitHubPullDiffPage, 'path'> {
  const offset = clampInteger(offsetInput, 0, text.length, 0);
  const limit = clampInteger(limitInput, 1, 60_000, REVIEW_DIFF_PAGE_LIMIT);
  const diff = text.slice(offset, offset + limit);
  const nextOffset = offset + diff.length;
  const truncated = nextOffset < text.length;
  return {
    diff,
    offset,
    returnedChars: diff.length,
    totalChars: text.length,
    truncated,
    ...(truncated ? { nextOffset } : {}),
  };
}

/**
 * Select one file's complete segment from a raw unified diff. We key from the
 * `+++ b/<path>` header instead of trying to parse shell-quoted `diff --git`
 * paths, which keeps spaces and renames deterministic.
 */
export function filterUnifiedDiffByPath(diff: string, path: string): string {
  const normalized = path.replace(/^b\//, '');
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return '';
  starts.push(diff.length);
  for (let index = 0; index < starts.length - 1; index++) {
    const segment = diff.slice(starts[index]!, starts[index + 1]!);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^\\+\\+\\+ b/${escaped}$`, 'm').test(segment)) return segment.trimEnd();
    // Deleted files use /dev/null on the new side; the old-side header is
    // still authoritative for the requested changed path.
    if (new RegExp(`^--- a/${escaped}$`, 'm').test(segment)) return segment.trimEnd();
  }
  return '';
}
