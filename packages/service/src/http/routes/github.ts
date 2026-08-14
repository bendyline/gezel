import {
  type GitHubCheckStatusResponse,
  GitHubCreateCommentRequestSchema,
  type GitHubCreateCommentResponse,
  GitHubCreatePullRequestSchema,
  type GitHubCreatePullResponse,
  type GitHubPullDiffResponse,
  type ListGitHubWorkflowRunsResponse,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';
import { gitError } from './git.js';

/**
 * GitHub web-service routes (Octokit-backed): pull requests, PR comments
 * and diffs, workflow runs, check status. Mounted under /api/projects, so
 * the URLs come out as `/api/projects/:id/github/*`. The host-agnostic
 * local-git routes live in ./git.ts.
 */
export function githubRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/github/prs', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    try {
      const pulls = await ctx.gitHubPrs.listPullRequests(project);
      return c.json({ pulls });
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get('/:id/github/prs/:num', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const detail = await ctx.gitHubPrs.getPullRequest(project, num);
      return c.json(detail);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/files', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const offset = optionalNonnegativeInt(c.req.query('offset'));
      const limit = optionalPositiveInt(c.req.query('limit'));
      const includePatch = c.req.query('includePatch') !== 'false';
      const paths = (c.req.queries('path') ?? [])
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean);
      const page = await ctx.gitHubPrs.listFilesPage(project, num, {
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        includePatch,
      });
      return c.json(page);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/comments', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const comments = await ctx.gitHubPrs.listComments(project, num);
      return c.json({ comments });
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get('/:id/github/prs/:num/diff', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    try {
      const offset = optionalNonnegativeInt(c.req.query('offset'));
      const limit = optionalPositiveInt(c.req.query('limit'));
      const path = c.req.query('path')?.trim();
      const page = await ctx.gitHubPrs.getPullRequestDiffPage(project, num, {
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(path ? { path } : {}),
      });
      const body: GitHubPullDiffResponse = { number: num, ...page };
      return c.json(body);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post('/:id/github/prs/:num/comments', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const num = Number.parseInt(c.req.param('num'), 10);
    if (!Number.isFinite(num)) return c.json({ error: 'invalid PR number' }, 400);
    const body = GitHubCreateCommentRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.gitHubPrs.createComment(project, num, body.body);
      const out: GitHubCreateCommentResponse = result;
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.post('/:id/github/prs', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const body = GitHubCreatePullRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.gitHubPrs.createPullRequest(project, {
        title: body.title,
        head: body.head,
        base: body.base,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.draft !== undefined ? { draft: body.draft } : {}),
      });
      const out: GitHubCreatePullResponse = result;
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
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
      const runs = await ctx.gitHubPrs.listWorkflowRuns(project, branch, limit);
      const out: ListGitHubWorkflowRunsResponse = { runs };
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  app.get('/:id/github/checks', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.github) return c.json({ error: 'project has no github link' }, 400);
    const ref = c.req.query('ref');
    if (!ref) return c.json({ error: 'missing ?ref=' }, 400);
    try {
      const result = await ctx.gitHubPrs.getCheckStatus(project, ref);
      const out: GitHubCheckStatusResponse = result;
      return c.json(out);
    } catch (err) {
      return gitError(c, err);
    }
  });

  return app;
}

function optionalNonnegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  const value = optionalNonnegativeInt(raw);
  return value !== undefined && value > 0 ? value : undefined;
}
