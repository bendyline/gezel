import {
  type CancelCodeReviewResponse,
  type CodeReviewResponse,
  type GitAbandonMergeResponse,
  GitAiMergeRequestSchema,
  type GitAiMergeResponse,
  GitBranchSwitchRequestSchema,
  type GitBranchesResponse,
  type GitChangesResponse,
  type GitCloneResponse,
  GitCommitRequestSchema,
  type GitCommitResponse,
  GitCompleteMergeRequestSchema,
  type GitCompleteMergeResponse,
  GitDiscardRequestSchema,
  type GitDiscardResponse,
  type GitFetchResponse,
  type GitLogResponse,
  type GitMergeStateResponse,
  type GitPushResponse,
  GitResolveConflictRequestSchema,
  type GitResolveConflictResponse,
  type GitStatusResponse,
  type GitSuggestMessageResponse,
  type GitSyncResponse,
  type ListCodeReviewsResponse,
  StartCodeReviewRequestSchema,
  type StartCodeReviewResponse,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  FileTooLargeForAiError,
  proposeMergeResolution,
  suggestCommitMessage,
} from '../../git/ai.js';
import {
  ConflictsRemainError,
  DetachedHeadError,
  GitNotInstalledError,
  MergeInProgressError,
  MissingPatError,
  NoDefaultBranchError,
  NoGitHubLinkError,
  NotInMergeError,
  NothingToReviewError,
} from '../../git/manager.js';
import { ReviewInProgressError } from '../../git/reviews.js';
import { parseGitHubUrl } from '../../github/url.js';
import type { ServiceContext } from '../context.js';

/**
 * Local-git routes, host-agnostic in behavior (status, changes, commits,
 * branches, sync, merge). Mounted under /api/projects with the canonical
 * `git` segment — `/api/projects/:id/git/*` — and a second time with the
 * legacy `github` segment so older HTTP clients (a stale VSCode extension
 * against a newer machine daemon) keep working. The GitHub web-service
 * surface (PRs, checks, workflow runs) lives in ./github.ts.
 */
export function gitRoutes(ctx: ServiceContext, segment: 'git' | 'github' = 'git'): Hono {
  const app = new Hono();

  app.get(`/:id/${segment}/status`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const status = await ctx.git.status(project);
    const body: GitStatusResponse = {
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

  app.post(`/:id/${segment}/clone`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    if (!parseGitHubUrl(project.github.url)) {
      return c.json({ error: `invalid GitHub URL: ${project.github.url}` }, 400);
    }
    try {
      const result = await ctx.git.ensureClone(project);
      const body: GitCloneResponse = {
        ok: true,
        checkoutDir: result.checkoutDir,
        adopted: result.adopted,
        ...(result.branch ? { branch: result.branch } : {}),
      };
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/pull`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.git.pull(project);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/branch`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitBranchSwitchRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.git.checkoutBranch(project, body.branch, {
        create: body.create ?? false,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/branches`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.git.listBranches(project);
      const body: GitBranchesResponse = result;
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/fetch`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.git.fetch(project);
      const body: GitFetchResponse = { ok: true, fetched: result.fetched };
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/commit`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitCommitRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.git.commit(project, {
        message: body.message,
        ...(body.allowEmpty ? { allowEmpty: true } : {}),
      });
      const out: GitCommitResponse = {
        ok: true,
        sha: result.sha,
        filesChanged: result.filesChanged,
      };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/push`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const result = await ctx.git.push(project);
      const body: GitPushResponse = {
        ok: true,
        pushed: result.pushed,
        ...(result.rejected ? { rejected: result.rejected } : {}),
      };
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/files`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const files = await ctx.git.listFiles(project);
      return c.json({ files });
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/files/read`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const content = await ctx.git.readFile(project, filePath);
      if (content === null) return c.json({ error: 'not found' }, 404);
      return c.json({ path: filePath, content });
    } catch (err) {
      return gitError(c, err);
    }
  });

  // ── changes / history ─────────────────────────────────────────────

  app.get(`/:id/${segment}/changes`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body: GitChangesResponse = await ctx.git.listChanges(project);
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/changes/diff`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const body = await ctx.git.fileDiff(project, filePath);
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/discard`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitDiscardRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.git.discardChanges(project, {
        ...(body.paths ? { paths: body.paths } : {}),
        ...(body.all ? { all: true } : {}),
      });
      const out: GitDiscardResponse = { ok: true, discarded: result.discarded };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/log`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const limitRaw = c.req.query('limit');
    const skipRaw = c.req.query('skip');
    try {
      const body: GitLogResponse = await ctx.git.log(project, {
        ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
        ...(skipRaw ? { skip: Number.parseInt(skipRaw, 10) } : {}),
      });
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/log/:sha`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body = await ctx.git.commitDetail(project, c.req.param('sha'));
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // ── sync + merge ──────────────────────────────────────────────────

  app.post(`/:id/${segment}/sync`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      // Every expected outcome (auth/offline/conflicts/needs-save) is a
      // 200 with a `state` discriminator; only infra errors become 5xx.
      const body: GitSyncResponse = await ctx.git.sync(project);
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/merge`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const body: GitMergeStateResponse = await ctx.git.mergeState(project);
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get(`/:id/${segment}/merge/file`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const body = await ctx.git.conflictFileVersions(project, filePath);
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/merge/resolve`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitResolveConflictRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.git.resolveConflictFile(project, body.path, {
        choice: body.choice,
        ...(body.content !== undefined ? { content: body.content } : {}),
      });
      const out: GitResolveConflictResponse = { ok: true, remaining: result.remaining };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/merge/complete`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitCompleteMergeRequestSchema.parse(await c.req.json().catch(() => ({})));
    try {
      const result = await ctx.git.completeMerge(project, {
        ...(body.message ? { message: body.message } : {}),
      });
      const out: GitCompleteMergeResponse = { ok: true, sha: result.sha };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post(`/:id/${segment}/merge/abandon`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      await ctx.git.abandonMerge(project);
      const out: GitAbandonMergeResponse = { ok: true };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  // ── code reviews ──────────────────────────────────────────────────
  // Registered on the canonical `git` segment only — nothing older than
  // this feature calls them, so the legacy /github alias stays lean.

  if (segment === 'git') {
    app.post(`/:id/${segment}/reviews`, async (c) => {
      const project = await ctx.store.getProject(c.req.param('id'));
      if (!project) return c.json({ error: 'not found' }, 404);
      if (!project.github) return c.json({ error: 'project has no github link' }, 400);
      const body = StartCodeReviewRequestSchema.parse(await c.req.json());
      try {
        const record = await ctx.codeReviews.start(project, body.kind);
        const review = await ctx.codeReviews.enrich(project.id, record);
        const out: StartCodeReviewResponse = { ok: true, review };
        return c.json(out);
      } catch (err) {
        return gitError(c, err);
      }
    });

    app.get(`/:id/${segment}/reviews`, async (c) => {
      const project = await ctx.store.getProject(c.req.param('id'));
      if (!project) return c.json({ error: 'not found' }, 404);
      if (!project.github) return c.json({ error: 'project has no github link' }, 400);
      try {
        const records = await ctx.codeReviews.list(project.id);
        // Enrich the live rows + the freshest few; terminal history rows
        // beyond that render fine from the record alone.
        const reviews = await Promise.all(
          records.map((r, i) =>
            r.status === 'running' || i < 5 ? ctx.codeReviews.enrich(project.id, r) : r,
          ),
        );
        const out: ListCodeReviewsResponse = { reviews };
        return c.json(out);
      } catch (err) {
        return gitError(c, err);
      }
    });

    app.get(`/:id/${segment}/reviews/:reviewId`, async (c) => {
      const project = await ctx.store.getProject(c.req.param('id'));
      if (!project) return c.json({ error: 'not found' }, 404);
      if (!project.github) return c.json({ error: 'project has no github link' }, 400);
      try {
        const record = await ctx.codeReviews.get(project.id, c.req.param('reviewId'));
        if (!record) return c.json({ error: 'not found' }, 404);
        const out: CodeReviewResponse = await ctx.codeReviews.enrich(project.id, record);
        return c.json(out);
      } catch (err) {
        return gitError(c, err);
      }
    });

    app.post(`/:id/${segment}/reviews/:reviewId/cancel`, async (c) => {
      const project = await ctx.store.getProject(c.req.param('id'));
      if (!project) return c.json({ error: 'not found' }, 404);
      if (!project.github) return c.json({ error: 'project has no github link' }, 400);
      try {
        const record = await ctx.codeReviews.cancel(project, c.req.param('reviewId'));
        const review = await ctx.codeReviews.enrich(project.id, record);
        const out: CancelCodeReviewResponse = { ok: true, review };
        return c.json(out);
      } catch (err) {
        return gitError(c, err);
      }
    });
  }

  // ── AI assists ────────────────────────────────────────────────────

  app.post(`/:id/${segment}/ai/suggest-message`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const { diff, changedPaths } = await ctx.git.workingDiff(project);
      if (changedPaths.length === 0) return c.json({ error: 'no changes' }, 400);
      const message = await suggestCommitMessage(ctx.chat, { diff, changedPaths });
      if (!message) return c.json({ error: 'suggestion came back empty' }, 503);
      const out: GitSuggestMessageResponse = { message };
      return c.json(out);
    } catch (err) {
      // AI unavailability is expected (no provider configured, model
      // busy) — 503 lets the UI fall back to its template quietly.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 503);
    }
  });

  app.post(`/:id/${segment}/ai/merge`, async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitAiMergeRequestSchema.parse(await c.req.json());
    try {
      const versions = await ctx.git.conflictFileVersions(project, body.path);
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
      const out: GitAiMergeResponse = { path: body.path, merged };
      return c.json(out);
    } catch (err) {
      if (err instanceof FileTooLargeForAiError) {
        return c.json({ error: err.message }, 413);
      }
      if (err instanceof NotInMergeError) {
        return gitError(c, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 503);
    }
  });

  return app;
}

/** Maps git-layer error classes to HTTP codes. Shared with ./github.ts. */
export function gitError(c: import('hono').Context, err: unknown) {
  if (err instanceof ReviewInProgressError) {
    return c.json({ error: err.message, code: 'REVIEW_IN_PROGRESS', review: err.review }, 409);
  }
  if (err instanceof NothingToReviewError) {
    return c.json({ error: err.message, code: 'NOTHING_TO_REVIEW' }, 400);
  }
  if (err instanceof NoDefaultBranchError) {
    return c.json({ error: err.message, code: 'NO_DEFAULT_BRANCH' }, 400);
  }
  if (err instanceof DetachedHeadError) {
    return c.json({ error: err.message, code: 'DETACHED_HEAD' }, 400);
  }
  if (err instanceof MissingPatError) {
    return c.json({ error: err.message, code: 'MISSING_PAT' }, 400);
  }
  if (err instanceof NoGitHubLinkError) {
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
