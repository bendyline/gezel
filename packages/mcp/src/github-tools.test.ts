import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { registerGitHubTools } from './github-tools.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function setup(api: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _shape: unknown, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  const resolveProjectId = vi.fn(async (input: string) => `resolved:${input}`);
  registerGitHubTools({
    server: server as unknown as McpServer,
    api: api as unknown as GezelClient,
    projectId: 'p1',
    resolveProjectId,
    unwrapApiError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  async function call(name: string, args: Record<string, unknown>) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} was not registered`);
    const result = await handler(args, {});
    const block = result.content[0];
    return { text: block?.type === 'text' ? block.text : '', isError: result.isError === true };
  }
  return { handlers, resolveProjectId, call };
}

function pull(number: number, headRef: string) {
  return {
    number,
    title: `PR ${number}`,
    author: 'ada',
    headRef,
    baseRef: 'main',
    draft: false,
    url: `https://example.test/pull/${number}`,
  };
}

describe('registerGitHubTools', () => {
  it('registers every GitHub tool', () => {
    expect([...setup({}).handlers.keys()]).toEqual([
      'github_pr_list',
      'github_pr_view',
      'github_pr_files',
      'github_pr_file',
      'github_pr_diff',
      'github_pr_comments',
      'github_pr_comment',
      'github_pr_create',
      'github_workflow_runs',
      'github_check_status',
    ]);
  });

  it('lists the PR for the checked-out branch first and marks it the default', async () => {
    const api = {
      listProjectGitHubPulls: vi.fn(async () => ({
        pulls: [pull(1, 'other'), pull(2, 'feature')],
      })),
      getProjectGitStatus: vi.fn(async () => ({ branch: 'feature' })),
    };
    const { call, resolveProjectId } = setup(api);

    const { text } = await call('github_pr_list', { project: 'Site' });

    expect(resolveProjectId).toHaveBeenCalledWith('Site');
    expect(api.listProjectGitHubPulls).toHaveBeenCalledWith('resolved:Site');
    expect(text.indexOf('#2 ')).toBeLessThan(text.indexOf('#1 '));
    expect(text).toContain('Current branch match — default: feature');
  });

  it('still lists PRs when the project has no readable checkout', async () => {
    const { call } = setup({
      listProjectGitHubPulls: async () => ({ pulls: [pull(1, 'other')] }),
      getProjectGitStatus: async () => {
        throw new Error('no checkout');
      },
    });

    const result = await call('github_pr_list', {});

    expect(result.isError).toBe(false);
    expect(result.text).toContain('#1 — PR 1');
    expect(result.text).not.toContain('Current branch match');
  });

  it('pages changed files as metadata by default and says where to continue', async () => {
    const api = {
      listProjectGitHubPullFiles: vi.fn(async () => ({
        files: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }],
        offset: 100,
        totalFiles: 150,
        hasMore: true,
        nextOffset: 101,
        includesPatch: false,
      })),
    };
    const { call } = setup(api);

    const { text } = await call('github_pr_files', { number: 7, offset: 100, limit: 1 });

    expect(api.listProjectGitHubPullFiles).toHaveBeenCalledWith('p1', 7, {
      offset: 100,
      limit: 1,
      includePatch: false,
    });
    expect(text).toContain('Coverage: files 101-101 of 150.');
    expect(text).toContain('hasMore: true; nextOffset: 101.');
    expect(text).toContain('a.ts — modified (+3 −1)');
  });

  it('reports a changed path that is not in the PR as an error', async () => {
    const api = { listProjectGitHubPullFiles: vi.fn(async () => ({ files: [] })) };
    const { call } = setup(api);

    const result = await call('github_pr_file', { number: 7, path: 'missing.ts' });

    expect(api.listProjectGitHubPullFiles).toHaveBeenCalledWith('p1', 7, {
      paths: ['missing.ts'],
      limit: 1,
      includePatch: true,
    });
    expect(result).toEqual({ text: 'Changed path not found: missing.ts', isError: true });
  });

  it('tells the caller the next offset of a truncated diff page', async () => {
    const { call } = setup({
      getProjectGitHubPullDiff: async () => ({
        diff: '+added line',
        path: 'a.ts',
        offset: 0,
        returnedChars: 11,
        totalChars: 30,
        truncated: true,
        nextOffset: 11,
      }),
    });

    const { text } = await call('github_pr_diff', { number: 7, path: 'a.ts' });

    expect(text).toContain('Diff page for a.ts: chars 0-11 of 30.');
    expect(text).toContain('truncated: true; nextOffset: 11.');
  });

  it('opens a PR without sending optional fields the caller left out', async () => {
    const api = {
      createProjectGitHubPullRequest: vi.fn(async () => ({
        number: 9,
        url: 'https://example.test/pull/9',
      })),
    };
    const { call } = setup(api);

    const { text } = await call('github_pr_create', { title: 'Fix', head: 'fix', base: 'main' });

    expect(api.createProjectGitHubPullRequest).toHaveBeenCalledWith('p1', {
      title: 'Fix',
      head: 'fix',
      base: 'main',
    });
    expect(text).toBe('Opened PR #9 — https://example.test/pull/9');
  });

  it('returns an API failure as a tool error naming the tool', async () => {
    const { call } = setup({
      getProjectGitHubPull: async () => {
        throw new Error('GitHub token missing');
      },
    });

    expect(await call('github_pr_view', { number: 3 })).toEqual({
      text: 'github_pr_view failed: GitHub token missing',
      isError: true,
    });
  });
});
