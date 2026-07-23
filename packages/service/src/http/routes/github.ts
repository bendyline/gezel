import {
  type GithubAbandonMergeResponse,
  GithubAiMergeRequestSchema,
  type GithubAiMergeResponse,
  GithubBranchSwitchRequestSchema,
  type GithubBranchesResponse,
  type GithubChangesResponse,
  type GithubCheckStatusResponse,
  type GithubCloneResponse,
  GithubCommitRequestSchema,
  type GithubCommitResponse,
  GithubCompleteMergeRequestSchema,
  type GithubCompleteMergeResponse,
  GithubCreateCommentRequestSchema,
  type GithubCreateCommentResponse,
  GithubCreatePullRequestSchema,
  type GithubCreatePullResponse,
  GithubDiscardRequestSchema,
  type GithubDiscardResponse,
  type GithubFetchResponse,
  type GithubLogResponse,
  type GithubMergeStateResponse,
  type GithubPullDiffResponse,
  type GithubPushResponse,
  GithubResolveConflictRequestSchema,
  type GithubResolveConflictResponse,
  type GithubStatusResponse,
  type GithubSuggestMessageResponse,
  type GithubSyncResponse,
  type ListGithubWorkflowRunsResponse,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  FileTooLargeForAiError,
  proposeMergeResolution,
  suggestCommitMessage,
} from '../../github/ai.js';
import {
  ConflictsRemainError,
  GitNotInstalledError,
  MergeInProgressError,
  MissingPatError,
  NoGithubLinkError,
  NotInMergeError,
} from '../../github/manager.js';
import { parseGithubUrl } from '../../github/url.js';
import type { ServiceContext } from '../context.js';

/**
 * Routes mounted under /api/projects (alongside the main project routes), so
 * the URLs come out as `/api/projects/:id/github/*`.
 */
export function githubRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/github/status', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const status = await ctx.github.status(project);
    const body: GithubStatusResponse = {
      ...(status.github ? { github: status.github } : {}),
      exists: status.exists,
      ...(status.originMatches !== undefined ? { originMatches: status.originMatches } : {}),
      ...(status.branch ? { branch: status.branch } : {}),
      ...(status.ahead !== undefined ? { ahead: status.ahead } : {}),
      ...(status.behind !== undefined ? { behind: status.behind } : {}),
      ...(status.dirty !== undefined ? { dirty: status.dirty } : {}),
      ...(status.changesCount !== undefined ? { changesCount: status.changesCount } : {}),
      ...(status.conflictedCount !== undefined ? { conflictedCount: status.conflictedCount } : {}),
      ...(status.mergeInProgress !== undefined ? { mergeInProgress: status.mergeInProgress } : {}),
      ...(status.hasUpstream !== undefined ? { hasUpstream: status.hasUpstream } : {}),
      hasPat: status.hasPat,
      credentialSource: status.credentialSource,
    };
    return c.json(body);
  });

  app.post('/:id/github/clone', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    if (!parseGithubUrl(project.github.url)) {
      return c.json({ error: `invalid GitHub URL: ${project.github.url}` }, 400);
    }
    try {
      const result = await ctx.github.ensureClone(project);
      const body: GithubCloneResponse = {
        ok: true,
        checkoutDir: result.checkoutDir,
        adopted: result.adopted,
        ...(result.branch ? { branch: result.branch } : {}),
      };
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/pull', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.github.pull(project);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/branch', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubBranchSwitchRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.github.checkoutBranch(project, body.branch, {
        create: body.create ?? false,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/branches', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.github.listBranches(project);
      const body: GithubBranchesResponse = result;
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/fetch', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.github.fetch(project);
      const body: GithubFetchResponse = { ok: true, fetched: result.fetched };
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/commit', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubCommitRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.github.commit(project, {
        message: body.message,
        ...(body.allowEmpty ? { allowEmpty: true } : {}),
      });
      const out: GithubCommitResponse = {
        ok: true,
        sha: result.sha,
        filesChanged: result.filesChanged,
      };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/push', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.github.push(project);
      const body: GithubPushResponse = {
        ok: true,
        pushed: result.pushed,
        ...(result.rejected ? { rejected: result.rejected } : {}),
      };
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/files', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const files = await ctx.github.listFiles(project);
      return c.json({ files });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/files/read', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const content = await ctx.github.readFile(project, filePath);
      if (content === null) return c.json({ error: 'not found' }, 404);
      return c.json({ path: filePath, content });
    } catch (err) {
      return githubError(c, err);
    }
  });

  // ── changes / history ─────────────────────────────────────────────

  app.get('/:id/github/changes', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body: GithubChangesResponse = await ctx.github.listChanges(project);
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/changes/diff', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const body = await ctx.github.fileDiff(project, filePath);
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/discard', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubDiscardRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.github.discardChanges(project, {
        ...(body.paths ? { paths: body.paths } : {}),
        ...(body.all ? { all: true } : {}),
      });
      const out: GithubDiscardResponse = { ok: true, discarded: result.discarded };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/log', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const limitRaw = c.req.query('limit');
    const skipRaw = c.req.query('skip');
    try {
      const body: GithubLogResponse = await ctx.github.log(project, {
        ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
        ...(skipRaw ? { skip: Number.parseInt(skipRaw, 10) } : {}),
      });
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/log/:sha', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body = await ctx.github.commitDetail(project, c.req.param('sha'));
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  // ── sync + merge ──────────────────────────────────────────────────

  app.post('/:id/github/sync', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      // Every expected outcome (auth/offline/conflicts/needs-save) is a
      // 200 with a `state` discriminator; only infra errors become 5xx.
      const body: GithubSyncResponse = await ctx.github.sync(project);
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/merge', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body: GithubMergeStateResponse = await ctx.github.mergeState(project);
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/merge/file', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const body = await ctx.github.conflictFileVersions(project, filePath);
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/merge/resolve', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubResolveConflictRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.github.resolveConflictFile(project, body.path, {
        choice: body.choice,
        ...(body.content !== undefined ? { content: body.content } : {}),
      });
      const out: GithubResolveConflictResponse = { ok: true, remaining: result.remaining };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/merge/complete', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubCompleteMergeRequestSchema.parse(await c.req.json().catch(() => ({})));
    try {
      const result = await ctx.github.completeMerge(project, {
        ...(body.message ? { message: body.message } : {}),
      });
      const out: GithubCompleteMergeResponse = { ok: true, sha: result.sha };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/merge/abandon', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      await ctx.github.abandonMerge(project);
      const out: GithubAbandonMergeResponse = { ok: true };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  // ── AI assists ────────────────────────────────────────────────────

  app.post('/:id/github/ai/suggest-message', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const { diff, changedPaths } = await ctx.github.workingDiff(project);
      if (changedPaths.length === 0) return c.json({ error: 'no changes' }, 400);
      const message = await suggestCommitMessage(ctx.chat, { diff, changedPaths });
      if (!message) return c.json({ error: 'suggestion came back empty' }, 503);
      const out: GithubSuggestMessageResponse = { message };
      return c.json(out);
    } catch (err) {
      // AI unavailability is expected (no provider configured, model
      // busy) — 503 lets the UI fall back to its template quietly.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 503);
    }
  });

  app.post('/:id/github/ai/merge', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubAiMergeRequestSchema.parse(await c.req.json());
    try {
      const versions = await ctx.github.conflictFileVersions(project, body.path);
      if (
        versions.binary ||
        versions.tooLarge ||
        versions.ours === undefined ||
        versions.theirs === undefined
      ) {
        return c.json(
          { error: 'This file cannot be combined automatically — pick one version instead.' },
          400,
        );
      }
      const merged = await proposeMergeResolution(ctx.chat, {
        path: body.path,
        ...(versions.base !== undefined ? { base: versions.base } : {}),
        ours: versions.ours,
        theirs: versions.theirs,
      });
      const out: GithubAiMergeResponse = { path: body.path, merged };
      return c.json(out);
    } catch (err) {
      if (err instanceof FileTooLargeForAiError) {
        return c.json({ error: err.message }, 413);
      }
      if (err instanceof NotInMergeError) {
        return githubError(c, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 503);
    }
  });

  // ── PR endpoints (octokit) ────────────────────────────────────────

  app.get('/:id/github/prs', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const pulls = await ctx.githubPrs.listPullRequests(project);
      return c.json({ pulls });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/prs/:num', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const detail = await ctx.githubPrs.getPullRequest(project, num);
      return c.json(detail);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/files', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const files = await ctx.githubPrs.listFiles(project, num);
      return c.json({ files });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/comments', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const comments = await ctx.githubPrs.listComments(project, num);
      return c.json({ comments });
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/diff', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const diff = await ctx.githubPrs.getPullRequestDiff(project, num);
      const body: GithubPullDiffResponse = { number: num, diff };
      return c.json(body);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/prs/:num/comments', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    const body = GithubCreateCommentRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.githubPrs.createComment(project, num, body.body);
      const out: GithubCreateCommentResponse = result;
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.post('/:id/github/prs', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GithubCreatePullRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.githubPrs.createPullRequest(project, {
        title: body.title,
        head: body.head,
        base: body.base,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.draft !== undefined ? { draft: body.draft } : {}),
      });
      const out: GithubCreatePullResponse = result;
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/workflow-runs', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const branch = c.req.query('branch');
    if (!branch) return c.json({ error: 'missing ?branch=' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10))) : 10;
    try {
      const runs = await ctx.githubPrs.listWorkflowRuns(project, branch, limit);
      const out: ListGithubWorkflowRunsResponse = { runs };
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  app.get('/:id/github/checks', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const ref = c.req.query('ref');
    if (!ref) return c.json({ error: 'missing ?ref=' }, 400);
    try {
      const result = await ctx.githubPrs.getCheckStatus(project, ref);
      const out: GithubCheckStatusResponse = result;
      return c.json(out);
    } catch (err) {
      return githubError(c, err);
    }
  });

  return app;
}

function githubError(c: import('hono').Context, err: unknown) {
  if (err instanceof MissingPatError) {
    return c.json({ error: err.message, code: 'MISSING_PAT' }, 400);
  }
  if (err instanceof NoGithubLinkError) {
    return c.json({ error: err.message, code: 'NO_GITHUB_LINK' }, 400);
  }
  if (err instanceof GitNotInstalledError) {
    return c.json({ error: err.message, code: 'GIT_NOT_INSTALLED' }, 500);
  }
  if (err instanceof MergeInProgressError) {
    return c.json({ error: err.message, code: 'MERGE_IN_PROGRESS' }, 409);
  }
  if (err instanceof NotInMergeError) {
    return c.json({ error: err.message, code: 'NOT_IN_MERGE' }, 409);
  }
  if (err instanceof ConflictsRemainError) {
    return c.json({ error: err.message, code: 'CONFLICTS_REMAIN', paths: err.paths }, 409);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
