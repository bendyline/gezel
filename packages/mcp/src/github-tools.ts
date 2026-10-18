import { prioritizePullsForCurrentBranch } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface GitHubToolDependencies {
  server: McpServer;
  api: GezelClient;
  projectId: string;
  resolveProjectId(input: string): Promise<string>;
  unwrapApiError(error: unknown): string;
}

// ── GitHub (PR + workflow operations) ──
//
// These tools wrap the per-project GitHub manager and PR client so
// craftbooks (and free-form gezels) can review PRs, post comments,
// open PRs, and watch CI without shelling out to the `gh` CLI. The
// auth piggybacks on the github toolset PAT — no per-tool config.
export function registerGitHubTools(dependencies: GitHubToolDependencies): void {
  const { server, api, projectId, resolveProjectId, unwrapApiError } = dependencies;

  server.tool(
    'github_pr_list',
    "List open pull requests on the current project's linked GitHub repo. Returns title, author, branches, and PR number. When the project has a local checkout, PRs whose head matches the checked-out branch are listed first and explicitly marked as the default. Use this to find the right PR for a review or ship operation.",
    {
      project: z
        .string()
        .optional()
        .describe('Project id or name. Defaults to the current project.'),
    },
    async ({ project }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const [res, status] = await Promise.all([
          api.listProjectGitHubPulls(resolved),
          api.getProjectGitStatus(resolved).catch(() => null),
        ]);
        const prioritized = prioritizePullsForCurrentBranch(res.pulls, status?.branch);
        if (!prioritized.pulls.length) {
          return { content: [{ type: 'text' as const, text: 'No open pull requests.' }] };
        }
        const lines = prioritized.pulls.map((p) => {
          const currentBranchMatch =
            prioritized.currentBranch && p.headRef === prioritized.currentBranch;
          return [
            `#${p.number} — ${p.title} (${p.author}, ${p.headRef} → ${p.baseRef}${p.draft ? ', draft' : ''})`,
            `  ${p.url}`,
            ...(currentBranchMatch
              ? [
                  `  Current branch match${prioritized.matchingCount === 1 ? ' — default' : ''}: ${prioritized.currentBranch}`,
                ]
              : []),
          ].join('\n');
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_list failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_view',
    'Fetch metadata for a single pull request: title, body, branches, state, mergeable, additions/deletions, changed file count. Use before /review or /ship to confirm scope.',
    {
      project: z.string().optional(),
      number: z.number().int().positive().describe('PR number'),
    },
    async ({ project, number }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const pr = await api.getProjectGitHubPull(resolved, number);
        const lines = [
          `#${pr.number} — ${pr.title}`,
          `Author: ${pr.author}`,
          `Branches: ${pr.headRef} → ${pr.baseRef}${pr.draft ? ' (draft)' : ''}`,
          `State: ${pr.state}${pr.merged ? ', merged' : ''}${pr.mergeable === false ? ', NOT mergeable' : ''}`,
          `Changes: +${pr.additions} −${pr.deletions} across ${pr.changedFiles} file(s)`,
          `URL: ${pr.url}`,
          '',
          pr.body || '(no description)',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_view failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_files',
    'List a bounded page of files changed in a PR. Defaults to compact metadata only so filenames later in a large PR are never hidden behind early patch bodies. Follow `nextOffset` until `hasMore: false`; set includePatch only for a small page, or use github_pr_file for one path.',
    {
      project: z.string().optional(),
      number: z.number().int().positive(),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Zero-based file offset (default 0).'),
      limit: z.number().int().min(1).max(200).optional().describe('Files per page (default 100).'),
      paths: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe('Optional exact changed paths to select.'),
      includePatch: z
        .boolean()
        .optional()
        .describe('Include bounded patches for this page. Defaults false.'),
    },
    async ({ project, number, offset, limit, paths, includePatch }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.listProjectGitHubPullFiles(resolved, number, {
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(paths ? { paths } : {}),
          includePatch: includePatch === true,
        });
        if (!res.files.length) {
          return {
            content: [
              {
                type: 'text' as const,
                text: paths?.length
                  ? `No changed files matched: ${paths.join(', ')}`
                  : 'No file changes in this PR.',
              },
            ],
          };
        }
        const blocks = res.files.map((f) => {
          const header = `${f.filename} — ${f.status} (+${f.additions} −${f.deletions})`;
          if (!f.patch) return header;
          const truncation = f.patchTruncated
            ? `\n[patch truncated: returned ${f.patch.length} of ${f.patchChars ?? '?'} chars; call github_pr_diff with path="${f.filename}" and nextOffset until complete]`
            : '';
          return `${header}\n\`\`\`diff\n${f.patch}\n\`\`\`${truncation}`;
        });
        const start = res.offset ?? offset ?? 0;
        const total = res.totalFiles ?? res.files.length;
        const end = start + res.files.length;
        const coverage = [
          `Coverage: files ${start + 1}-${end} of ${total}${res.allFiles !== undefined && res.allFiles !== total ? ` selected from ${res.allFiles} PR files` : ''}.`,
          `Patches: ${res.includesPatch ? 'included where available' : 'omitted (metadata-only)'}.`,
          res.hasMore
            ? `hasMore: true; nextOffset: ${res.nextOffset ?? end}. Call github_pr_files again with that offset.`
            : 'hasMore: false; this selection is complete.',
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text: `${coverage}\n\n${blocks.join('\n\n')}` }],
        };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_files failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_file',
    'Fetch one changed path and its bounded patch. Use this after github_pr_files identifies a file; if the patch is truncated, continue with github_pr_diff({ number, path, offset: nextOffset }).',
    {
      project: z.string().optional(),
      number: z.number().int().positive(),
      path: z.string().min(1).describe('Exact changed path from github_pr_files.'),
    },
    async ({ project, number, path }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.listProjectGitHubPullFiles(resolved, number, {
          paths: [path],
          limit: 1,
          includePatch: true,
        });
        const file = res.files[0];
        if (!file) {
          return {
            content: [{ type: 'text' as const, text: `Changed path not found: ${path}` }],
            isError: true,
          };
        }
        const header = `${file.filename} — ${file.status} (+${file.additions} −${file.deletions})`;
        const patch = file.patch
          ? `\n\n\`\`\`diff\n${file.patch}\n\`\`\``
          : '\n\n(No patch returned.)';
        const truncation = file.patchTruncated
          ? `\n\nPatch truncated: returned ${file.patch?.length ?? 0} of ${file.patchChars ?? '?'} chars. Call github_pr_diff({ number: ${number}, path: ${JSON.stringify(file.filename)} }) and follow nextOffset.`
          : '';
        return { content: [{ type: 'text' as const, text: `${header}${patch}${truncation}` }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_file failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_diff',
    'Fetch one explicit character page of a PR diff, optionally scoped to an exact changed path. The result always reports totalChars, truncated, and nextOffset; continue until truncated is false. For large PR discovery, page github_pr_files first instead of assuming one diff call is complete.',
    {
      project: z.string().optional(),
      number: z.number().int().positive(),
      path: z.string().min(1).optional().describe('Optional exact changed path.'),
      offset: z.number().int().nonnegative().optional().describe('Character offset (default 0).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60_000)
        .optional()
        .describe('Characters to return (default 48,000; max 60,000).'),
    },
    async ({ project, number, path, offset, limit }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.getProjectGitHubPullDiff(resolved, number, {
          ...(path ? { path } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const scope = res.path ? ` for ${res.path}` : '';
        const start = res.offset ?? offset ?? 0;
        const returned = res.returnedChars ?? res.diff.length;
        const total = res.totalChars ?? res.diff.length;
        const meta = [
          `Diff page${scope}: chars ${start}-${start + returned} of ${total}.`,
          res.truncated
            ? `truncated: true; nextOffset: ${res.nextOffset ?? start + returned}. Continue with the same path and that offset.`
            : 'truncated: false; this diff selection is complete.',
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text: `${meta}\n\n${res.diff || '(empty diff)'}` }],
        };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_diff failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_comments',
    "List comments on a PR — both top-level (issue) comments and inline review comments. Use before posting a new comment so you don't duplicate ground that's already been covered.",
    {
      project: z.string().optional(),
      number: z.number().int().positive(),
    },
    async ({ project, number }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.listProjectGitHubPullComments(resolved, number);
        if (!res.comments.length) {
          return { content: [{ type: 'text' as const, text: 'No comments on this PR.' }] };
        }
        const lines = res.comments.map((c) => {
          const tag = c.kind === 'review' && c.path ? `[review on ${c.path}]` : '[comment]';
          return `${tag} ${c.author} @ ${c.createdAt}\n${c.body}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n\n---\n\n') }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_comments failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_comment',
    'Post a top-level comment to a PR. Use this to surface a review summary, a question to the author, or a status update from a craftbook. Returns the new comment id + URL.',
    {
      project: z.string().optional(),
      number: z.number().int().positive(),
      body: z.string().min(1).describe('Markdown body of the comment.'),
    },
    async ({ project, number, body }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.createProjectGitHubPullComment(resolved, number, body);
        return {
          content: [{ type: 'text' as const, text: `Posted comment ${res.id} — ${res.url}` }],
        };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_comment failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_pr_create',
    'Open a new pull request. `head` is the source branch (or `owner:branch` for cross-fork PRs); `base` is the target branch. Returns the new PR number + URL. The head branch must already exist on the remote; this tool does not commit or push local changes. If needed, ask the user to commit and push it from the project Git UI first.',
    {
      project: z.string().optional(),
      title: z.string().min(1),
      head: z.string().min(1).describe('Source branch (or owner:branch for cross-fork).'),
      base: z.string().min(1).describe('Target branch (typically "main").'),
      body: z.string().optional().describe('PR description (markdown).'),
      draft: z.boolean().optional().describe('Open as a draft PR.'),
    },
    async ({ project, title, head, base, body, draft }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.createProjectGitHubPullRequest(resolved, {
          title,
          head,
          base,
          ...(body !== undefined ? { body } : {}),
          ...(draft !== undefined ? { draft } : {}),
        });
        return {
          content: [{ type: 'text' as const, text: `Opened PR #${res.number} — ${res.url}` }],
        };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_pr_create failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_workflow_runs',
    'List recent CI workflow runs for a branch. Used by /ship and /canary to wait for checks before merging or to confirm a deploy succeeded. Returns id, name, status, conclusion, URL.',
    {
      project: z.string().optional(),
      branch: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ project, branch, limit }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.listProjectGitHubWorkflowRuns(resolved, branch, limit);
        if (!res.runs.length) {
          return {
            content: [{ type: 'text' as const, text: `No workflow runs for branch ${branch}.` }],
          };
        }
        const lines = res.runs.map(
          (r) =>
            `[${r.status}${r.conclusion ? `/${r.conclusion}` : ''}] ${r.name} — ${r.createdAt}\n  ${r.url}`,
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_workflow_runs failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'github_check_status',
    'Combined check status for a ref (branch or sha). Returns the overall state — success/failure/pending/unknown — plus a per-check breakdown. Use this to decide whether a PR is safe to merge.',
    {
      project: z.string().optional(),
      ref: z.string().min(1).describe('Branch name or commit sha.'),
    },
    async ({ project, ref }) => {
      const resolved = project ? await resolveProjectId(project) : projectId;
      try {
        const res = await api.getProjectGitHubChecks(resolved, ref);
        const header = `State: ${res.state} (${res.checks.length} check(s))`;
        if (!res.checks.length) {
          return {
            content: [{ type: 'text' as const, text: `${header}\nNo checks reported for ${ref}.` }],
          };
        }
        const lines = res.checks.map(
          (c) =>
            `• ${c.name} — ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ''}${c.url ? `\n  ${c.url}` : ''}`,
        );
        return { content: [{ type: 'text' as const, text: `${header}\n${lines.join('\n')}` }] };
      } catch (err) {
        const msg = unwrapApiError(err);
        return {
          content: [{ type: 'text' as const, text: `github_check_status failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
