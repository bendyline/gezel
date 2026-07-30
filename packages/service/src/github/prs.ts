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

  async listFiles(project: ProjectDetail, num: number): Promise<GitHubPullFile[]> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.pulls.listFiles({ owner, repo, pull_number: num, per_page: 100 });
    return res.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      ...(f.patch ? { patch: truncate(f.patch, REVIEW_PATCH_LIMIT) } : {}),
      ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
    }));
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
  async getPullRequestDiff(project: ProjectDetail, num: number): Promise<string> {
    const octo = await this.client();
    const { owner, repo } = this.repoOf(project);
    const res = await octo.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: num,
      headers: { accept: 'application/vnd.github.v3.diff' },
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return truncate(body, REVIEW_PATCH_LIMIT * 8);
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
