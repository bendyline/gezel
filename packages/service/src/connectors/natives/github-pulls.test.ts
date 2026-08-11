import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import { clearConnectorTaskPreps, connectorTaskPrepFor } from '../task-prep.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import {
  GitHubPullsAdapter,
  type GitHubPullsRuntime,
  pullNumberFromScope,
  pullScope,
  registerGitHubPullsAdapters,
  resolveLaunchPullNumber,
} from './github-pulls.js';

function project(overrides: Record<string, unknown> = {}): ProjectDetail {
  return {
    id: 'p1',
    name: 'gezel',
    github: { url: 'https://github.com/bendyline/gezel', branch: 'feature-x' },
    ...overrides,
  } as unknown as ProjectDetail;
}

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'pulls-binding', type: 'github-pulls', config };
}

function deps(): AdapterDeps {
  return { secrets: {} as unknown as SecretStore, store: {} as Store, projectId: 'p1' };
}

interface RuntimeOpts {
  open?: { number: number; headRef: string }[];
  files?: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
  diff?: string;
  patchLimits?: number[];
}

function runtime(opts: RuntimeOpts = {}): GitHubPullsRuntime {
  const open = opts.open ?? [{ number: 52, headRef: 'feature-x' }];
  const files =
    opts.files ??
    ([
      {
        filename: 'src/auth.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        patch: "@@ -1,3 +1,5 @@\n+const key = process.env.KEY ?? 'dev-admin-key';",
      },
    ] as RuntimeOpts['files'])!;
  return {
    prs: {
      listPullRequests: async () =>
        open.map((p) => ({
          number: p.number,
          title: `PR ${p.number}`,
          author: 'kim',
          headRef: p.headRef,
          baseRef: 'main',
          draft: false,
          updatedAt: '2026-08-10T00:00:00Z',
          url: `https://github.com/bendyline/gezel/pull/${p.number}`,
        })) as never,
      getPullRequest: async (_p, num) =>
        ({
          number: num,
          title: `PR ${num}`,
          author: 'kim',
          headRef: 'feature-x',
          baseRef: 'main',
          draft: false,
          updatedAt: '2026-08-10T00:00:00Z',
          url: `https://github.com/bendyline/gezel/pull/${num}`,
          body: 'Adds an auth fallback.',
          state: 'open',
          merged: false,
          mergeable: true,
          additions: 3,
          deletions: 1,
          changedFiles: files.length,
        }) as never,
      listFiles: async (_p, _num, o) => {
        if (o?.patchLimit !== undefined) opts.patchLimits?.push(o.patchLimit);
        return files as never;
      },
      listComments: async () => [] as never,
      getPullRequestDiff: async () => opts.diff ?? 'diff --git a/src/auth.ts b/src/auth.ts',
    },
    project: async () => project(),
  };
}

afterEach(() => {
  clearConnectorTaskPreps();
});

describe('scope naming', () => {
  it('round-trips a pull number', () => {
    expect(pullScope(52)).toBe('pr-52');
    expect(pullNumberFromScope('pr-52')).toBe(52);
    expect(pullNumberFromScope('inbox')).toBeNull();
    expect(pullNumberFromScope('pr-0')).toBeNull();
  });
});

describe('GitHubPullsAdapter', () => {
  it('lists one scope per open pull request', async () => {
    const adapter = new GitHubPullsAdapter(
      binding(),
      deps(),
      runtime({
        open: [
          { number: 52, headRef: 'feature-x' },
          { number: 41, headRef: 'other' },
        ],
      }),
    );
    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual(['pr-52', 'pr-41']);
  });

  it('emits an overview record plus one record per changed file', async () => {
    const adapter = new GitHubPullsAdapter(binding(), deps(), runtime());
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('pr-52', undefined);
    expect(batch.records.map((r) => r.id)).toEqual(['pr-52', 'pr-52-file-src/auth.ts']);

    const overview = await adapter.fetchRecord('pr-52', batch.records[0]!);
    expect(overview.frontmatter.pull).toBe('52');
    expect(overview.frontmatter.url).toContain('/pull/52');
    expect(overview.bodyMarkdown).toContain('Adds an auth fallback.');
    expect(overview.bodyMarkdown).toContain('`src/auth.ts`');
    // The full diff rides along as an attachment so a reviewer can read the
    // whole change without one record per hunk.
    expect(overview.attachments?.[0]?.filename).toBe('pr-52.diff');

    const file = await adapter.fetchRecord('pr-52', batch.records[1]!);
    expect(file.dirSegments).toEqual(['files']);
    expect(file.frontmatter.path).toBe('src/auth.ts');
    expect(file.bodyMarkdown).toContain('dev-admin-key');
  });

  it('fetches patches and the diff untruncated', async () => {
    // These land in files the model opens; a clip mid-hunk would read as
    // the change simply not being there.
    const patchLimits: number[] = [];
    const adapter = new GitHubPullsAdapter(binding(), deps(), runtime({ patchLimits }));
    await adapter.ensureAuth();
    await adapter.listChangesSince('pr-52', undefined);
    expect(patchLimits).toEqual([Number.POSITIVE_INFINITY]);
  });

  it('re-syncs nothing while the pull request is unchanged', async () => {
    const adapter = new GitHubPullsAdapter(binding(), deps(), runtime());
    await adapter.ensureAuth();
    const first = await adapter.listChangesSince('pr-52', undefined);
    const second = await adapter.listChangesSince('pr-52', first.cursor);
    expect(second.records).toEqual([]);
  });

  it('refuses to sync a project with no GitHub link', async () => {
    const rt = { ...runtime(), project: async () => project({ github: undefined }) };
    const adapter = new GitHubPullsAdapter(binding(), deps(), rt);
    await expect(adapter.ensureAuth()).rejects.toThrow(/not linked to a GitHub repository/);
  });
});

describe('launch prep', () => {
  it('targets one scope and hands back the real corpus path', async () => {
    // The path a step prompt interpolates has to be the one the artifact
    // tools resolve: `artifacts/` + the binding's own `corpusDir` (which
    // already carries `data/`). Doubling either segment yields a corpus
    // the reviewer would never find — the exact prompt-vs-reality gap this
    // craftbook exists to close.
    registerGitHubPullsAdapters(runtime());
    const prep = connectorTaskPrepFor('github-pulls');
    expect(prep).toBeDefined();

    const synced: { bindingId: string; scopes?: readonly string[] }[] = [];
    const result = await prep!({
      project: project(),
      binding: { id: 'pulls-binding', type: 'github-pulls', corpusDir: 'data/github-pulls' },
      params: {},
      sync: async (bindingId, opts) => {
        synced.push({ bindingId, ...(opts?.scopes ? { scopes: opts.scopes } : {}) });
        return { written: 2, quarantined: 0, skipped: 0, pruned: 0, errors: 0, cursor: undefined };
      },
    });

    expect(synced).toEqual([{ bindingId: 'pulls-binding', scopes: ['pr-52'] }]);
    expect(result.params).toEqual({
      number: '52',
      corpusScope: 'artifacts/data/github-pulls/pr-52',
    });
    expect(result.summary).toContain('PR #52');
  });

  it('fails the launch when the targeted sync errors', async () => {
    registerGitHubPullsAdapters(runtime());
    const prep = connectorTaskPrepFor('github-pulls');
    await expect(
      prep!({
        project: project(),
        binding: { id: 'pulls-binding', type: 'github-pulls', corpusDir: 'data/github-pulls' },
        params: {},
        sync: async () => ({
          written: 0,
          quarantined: 0,
          skipped: 0,
          pruned: 0,
          errors: 1,
          cursor: undefined,
          error: 'rate limited',
        }),
      }),
    ).rejects.toThrow(/Could not pull down PR #52: rate limited/);
  });
});

describe('resolveLaunchPullNumber', () => {
  it('prefers an explicit number param', async () => {
    const num = await resolveLaunchPullNumber(runtime(), project(), { number: '41' });
    expect(num).toBe(41);
  });

  it('defaults to the open pull request for the checked-out branch', async () => {
    const rt = runtime({
      open: [
        { number: 41, headRef: 'someone-else' },
        { number: 52, headRef: 'feature-x' },
      ],
    });
    expect(await resolveLaunchPullNumber(rt, project(), {})).toBe(52);
  });

  it('fails loudly when the branch has no open pull request', async () => {
    const rt = runtime({ open: [{ number: 41, headRef: 'someone-else' }] });
    await expect(resolveLaunchPullNumber(rt, project(), {})).rejects.toThrow(
      /No open pull request for branch "feature-x"/,
    );
  });
});
