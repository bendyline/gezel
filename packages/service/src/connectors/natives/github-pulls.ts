/**
 * GitHub Pull Requests connector. One scope per pull request (`pr-<n>`),
 * mirroring the PR into files a gezel can simply read: an overview record,
 * one record per changed file carrying that file's patch, and the complete
 * unified diff as an attachment.
 *
 * Why a connector and not the live `github_pr_*` tools: a review step that
 * has to fetch its own subject mid-turn needs those tools to survive every
 * layer of surface narrowing, and when they don't the step has no way to
 * comply (the Pull Request Review stall). Materializing first makes the
 * review a file-reading job, which every roster can do — including small
 * local models on a writes-off project.
 *
 * Per the connector standard the sync is runtime-initiated (task launch,
 * the ambient loop, or the Sync now button). There is deliberately no
 * model-callable fetch.
 */

import type { GitHubPullComment, GitHubPullDetail, GitHubPullFile } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { ProjectDetail } from '@bendyline/gezel';
import { prioritizePullsForCurrentBranch } from '@bendyline/gezel-mcp';
import type { GitHubPrs } from '../../github/prs.js';
import { registerNativeAdapter } from '../registry.js';
import { assertConnectorTaskSync, registerConnectorTaskPrep } from '../task-prep.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { slug } from '../writer.js';

const log = createLogger('connectors');

/** Newest-N open pull requests the ambient pass mirrors when unconfigured. */
const DEFAULT_MAX_PULLS = 20;

/** A scope name is the durable handle a task launch uses to target one PR. */
export function pullScope(num: number): string {
  return `pr-${num}`;
}

/** Inverse of {@link pullScope}; null when the scope isn't a PR scope. */
export function pullNumberFromScope(scope: string): number | null {
  const m = /^pr-(\d+)$/.exec(scope.trim());
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

interface GitHubPullsConfig {
  maxPulls: number;
  includeComments: boolean;
}

/**
 * The two collaborators the adapter needs, injected so tests drive it with
 * fixtures instead of the network.
 */
export interface GitHubPullsRuntime {
  prs: Pick<GitHubPrs, 'listPullRequests' | 'getPullRequest' | 'listFiles' | 'listComments'> & {
    getPullRequestDiff(
      project: ProjectDetail,
      num: number,
      opts?: { limit?: number },
    ): Promise<string>;
  };
  project(projectId: string): Promise<ProjectDetail>;
}

/** What one `pr-<n>` scope resolves to; assembled once per scope per pass. */
interface PullBundle {
  detail: GitHubPullDetail;
  files: GitHubPullFile[];
  comments: GitHubPullComment[];
  diff: string;
}

export class GitHubPullsAdapter implements ConnectorAdapter {
  readonly typeId = 'github-pulls';
  private config?: GitHubPullsConfig;
  private project?: ProjectDetail;
  private readonly bundles = new Map<number, PullBundle>();

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: GitHubPullsRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const projectId = this.deps.projectId;
    if (!projectId) throw new Error('GitHub Pulls connector requires a project binding.');
    // The repo comes from the project's GitHub link rather than binding
    // config: this connector only ever mirrors the repo the project is
    // already working in, and duplicating the coordinates invites drift.
    this.project = await this.runtime.project(projectId);
    if (!this.project.github?.url) {
      throw new Error(
        'This project is not linked to a GitHub repository. Link it in Project → GitHub, then sync again.',
      );
    }
  }

  async listScopes(): Promise<string[]> {
    const { project, config } = this.ready();
    const open = await this.runtime.prs.listPullRequests(project);
    return open.slice(0, config.maxPulls).map((p) => pullScope(p.number));
  }

  async listChangesSince(scope: string, cursor: unknown): Promise<ChangeBatch<string>> {
    const { project } = this.ready();
    const num = pullNumberFromScope(scope);
    if (num === null) return { records: [], cursor: '' };

    const bundle = await this.loadBundle(project, num);
    // `updatedAt` + head SHA is the whole change signal for a PR: a new
    // commit or a new comment moves one of them. Unchanged → nothing to
    // re-fetch, and the pass costs one API call.
    const next = `${bundle.detail.updatedAt}:${bundle.detail.headRef}:${bundle.files.length}`;
    if (typeof cursor === 'string' && cursor === next) {
      return { records: [], cursor: next, enumeratedAll: true };
    }

    const records: RecordRef[] = [
      {
        id: `pr-${num}`,
        ordinalKey: 0,
        ts: bundle.detail.updatedAt,
        raw: { kind: 'overview', num },
      },
      ...bundle.files.map((file, index) => ({
        id: `pr-${num}-file-${file.filename}`,
        // Files sort after the overview and hold their listing order, so a
        // reviewer walking the corpus reads the summary first.
        ordinalKey: -(index + 1),
        ts: bundle.detail.updatedAt,
        raw: { kind: 'file' as const, num, filename: file.filename },
      })),
    ];
    return { records, cursor: next, enumeratedAll: true };
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const { project } = this.ready();
    const raw = (ref.raw ?? {}) as { kind?: string; num?: number; filename?: string };
    const num = raw.num ?? pullNumberFromScope(scope);
    if (num === null || num === undefined) throw new Error(`not a pull-request scope: ${scope}`);
    const bundle = await this.loadBundle(project, num);

    if (raw.kind === 'file') {
      const file = bundle.files.find((f) => f.filename === raw.filename);
      if (!file) throw new Error(`pull request #${num} no longer changes ${raw.filename}`);
      return this.fileRecord(num, file);
    }
    return this.overviewRecord(num, bundle);
  }

  async close(): Promise<void> {
    this.bundles.clear();
  }

  private ready(): { project: ProjectDetail; config: GitHubPullsConfig } {
    if (!this.project || !this.config) {
      throw new Error('GitHub Pulls connector has not been initialized.');
    }
    return { project: this.project, config: this.config };
  }

  private async loadBundle(project: ProjectDetail, num: number): Promise<PullBundle> {
    const cached = this.bundles.get(num);
    if (cached) return cached;
    const { config } = this.ready();
    const [detail, files, comments, diff] = await Promise.all([
      this.runtime.prs.getPullRequest(project, num),
      // Unlimited patches: these land in files the model opens, so a clip
      // mid-hunk would read as the change simply not being there.
      this.runtime.prs.listFiles(project, num, { patchLimit: Number.POSITIVE_INFINITY }),
      config.includeComments
        ? this.runtime.prs.listComments(project, num)
        : Promise.resolve([] as GitHubPullComment[]),
      this.runtime.prs
        .getPullRequestDiff(project, num, { limit: Number.POSITIVE_INFINITY })
        .catch((err) => {
          // A missing diff degrades the corpus (per-file patches survive);
          // it should not fail the whole scope.
          log.warn(`github-pulls: could not fetch the unified diff for #${num}: ${err}`);
          return '';
        }),
    ]);
    const bundle: PullBundle = { detail, files, comments, diff };
    this.bundles.set(num, bundle);
    return bundle;
  }

  private overviewRecord(num: number, bundle: PullBundle): NormalizedRecord {
    const { detail, files, comments, diff } = bundle;
    const body = [
      `# PR #${num}: ${detail.title}`,
      '',
      `${detail.author} wants to merge \`${detail.headRef}\` into \`${detail.baseRef}\`.`,
      `${detail.changedFiles} file(s) changed, +${detail.additions} / -${detail.deletions}.`,
      '',
      '## Description',
      '',
      detail.body.trim() || '_No description provided._',
      '',
      '## Changed files',
      '',
      ...files.map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions} / -${f.deletions})`),
    ];
    if (comments.length > 0) {
      body.push('', '## Comments', '');
      for (const c of comments) {
        const where = c.path ? ` on \`${c.path}\`` : '';
        body.push(`### ${c.author}${where} — ${c.createdAt}`, '', c.body.trim(), '');
      }
    }

    return {
      recordId: `pr-${num}`,
      dirSegments: [],
      fileStem: slug(`pr-${num}-overview`, 96),
      frontmatter: {
        direction: 'inbound',
        title: detail.title,
        pull: String(num),
        author: detail.author,
        state: detail.merged ? 'merged' : detail.state,
        draft: String(detail.draft),
        headRef: detail.headRef,
        baseRef: detail.baseRef,
        changedFiles: String(detail.changedFiles),
        additions: String(detail.additions),
        deletions: String(detail.deletions),
        commentCount: String(comments.length),
        updatedAt: detail.updatedAt,
        url: detail.url,
      },
      bodyMarkdown: body.join('\n'),
      scanOrigin: 'github-pulls',
      quarantineNamespace: 'github-pulls',
      quarantineLabel: `GitHub pull request #${num}`,
      ...(diff
        ? {
            attachments: [
              {
                filename: `pr-${num}.diff`,
                content: new TextEncoder().encode(diff),
                size: Buffer.byteLength(diff, 'utf8'),
              },
            ],
          }
        : {}),
    };
  }

  private fileRecord(num: number, file: GitHubPullFile): NormalizedRecord {
    const body = [
      `# \`${file.filename}\``,
      '',
      `Status: ${file.status} (+${file.additions} / -${file.deletions}).`,
      ...(file.previousFilename ? [`Renamed from \`${file.previousFilename}\`.`] : []),
      '',
      ...(file.patch
        ? ['```diff', file.patch, '```']
        : ['_No patch available (binary file, or the change is too large for the API)._']),
    ];
    return {
      recordId: `pr-${num}-file-${file.filename}`,
      dirSegments: ['files'],
      fileStem: slug(file.filename, 96),
      frontmatter: {
        direction: 'inbound',
        title: file.filename,
        pull: String(num),
        path: file.filename,
        status: file.status,
        additions: String(file.additions),
        deletions: String(file.deletions),
      },
      bodyMarkdown: body.join('\n'),
      scanOrigin: 'github-pulls',
      quarantineNamespace: 'github-pulls',
      quarantineLabel: `Changed file "${file.filename}" in pull request #${num}`,
    };
  }
}

function parseConfig(raw: unknown): GitHubPullsConfig {
  const cfg = (raw ?? {}) as { maxPulls?: unknown; includeComments?: unknown };
  const maxPulls =
    typeof cfg.maxPulls === 'number' && Number.isSafeInteger(cfg.maxPulls) && cfg.maxPulls > 0
      ? cfg.maxPulls
      : DEFAULT_MAX_PULLS;
  return {
    maxPulls,
    includeComments: cfg.includeComments !== false,
  };
}

/**
 * Resolve which pull request a task launch is about: an explicit `number`
 * param wins, otherwise the open PR for the checked-out branch. Exported
 * for the launch-prep test — the selection rule is the part users notice
 * when it is wrong.
 */
export async function resolveLaunchPullNumber(
  runtime: Pick<GitHubPullsRuntime, 'prs'>,
  project: ProjectDetail,
  params: Record<string, string>,
): Promise<number> {
  const explicit = Number((params.number ?? '').trim());
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;

  const open = await runtime.prs.listPullRequests(project);
  const branch = project.github?.branch;
  const { pulls, matchingCount } = prioritizePullsForCurrentBranch(open, branch);
  if (matchingCount > 0 && pulls[0]) return pulls[0].number;
  throw new Error(
    branch
      ? `No open pull request for branch "${branch}". Pass an explicit PR number to review one from another branch.`
      : 'No pull request selected and the project checkout has no branch. Pass an explicit PR number.',
  );
}

/** Register the GitHub Pulls native adapter and its launch-time prep. */
export function registerGitHubPullsAdapters(runtime: GitHubPullsRuntime): void {
  registerNativeAdapter('github-pulls', async (binding, deps) =>
    Promise.resolve(new GitHubPullsAdapter(binding, deps, runtime)),
  );
  registerConnectorTaskPrep('github-pulls', async (ctx) => {
    const num = await resolveLaunchPullNumber(runtime, ctx.project, ctx.params);
    const scope = pullScope(num);
    const result = await ctx.sync(ctx.binding.id, { scopes: [scope] });
    assertConnectorTaskSync(result, `PR #${num}`);
    // `corpusScope` is the path the craftbook's step prompts and gate
    // checks interpolate, so a recipe never hard-codes the corpus name.
    // `corpusDir` already carries the `data/` prefix (resolveCorpusDir).
    const corpusDir = ctx.binding.corpusDir ?? 'data/github-pulls';
    const corpusScope = `artifacts/${corpusDir.startsWith('data/') ? corpusDir : `data/${corpusDir}`}/${scope}`;
    return {
      params: { number: String(num), corpusScope },
      summary: `PR #${num} → \`${corpusScope}/\` (${result.written} record(s) written)`,
    };
  });
}
