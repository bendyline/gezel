import type { GitHubPullFile, ProjectDetail } from '@bendyline/gezel';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { PATCH_LINE_LEGEND, parsePatchRecord } from '@bendyline/gezel/checks';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import { syncWithAdapter } from '../manager.js';
import { clearConnectorTaskPreps, connectorTaskPrepFor } from '../task-prep.js';
import { createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import { sha8 } from '../writer.js';
import {
  GitHubPullsAdapter,
  type GitHubPullsRuntime,
  REVIEW_MAX_FILES_PER_BATCH,
  REVIEW_TARGET_PATCH_CHARS,
  orderPullReviewFiles,
  partitionPullReviewFiles,
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
  /** What HEAD points at in the checkout; `null` = detached/unreadable. */
  currentBranch?: string | null;
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
    currentBranch: async () =>
      opts.currentBranch === null ? undefined : (opts.currentBranch ?? 'feature-x'),
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

describe('review batching', () => {
  const file = (number: number, patch?: string): GitHubPullFile =>
    ({
      filename: `src/file-${number}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch,
    }) as GitHubPullFile;

  it('caps file count even for tiny patches', () => {
    const files = Array.from({ length: REVIEW_MAX_FILES_PER_BATCH * 2 + 3 }, (_, index) =>
      file(index + 1, '+small'),
    );
    const batches = partitionPullReviewFiles(files);
    expect(batches.map((batch) => batch.paths.length)).toEqual([
      REVIEW_MAX_FILES_PER_BATCH,
      REVIEW_MAX_FILES_PER_BATCH,
      3,
    ]);
    expect(batches.map((batch) => [batch.start, batch.end])).toEqual([
      [1, REVIEW_MAX_FILES_PER_BATCH],
      [REVIEW_MAX_FILES_PER_BATCH + 1, REVIEW_MAX_FILES_PER_BATCH * 2],
      [REVIEW_MAX_FILES_PER_BATCH * 2 + 1, REVIEW_MAX_FILES_PER_BATCH * 2 + 3],
    ]);
  });

  it('splits on patch size and isolates a single oversized record', () => {
    const half = 'x'.repeat(REVIEW_TARGET_PATCH_CHARS / 2);
    const files = [file(1, half), file(2, half), file(3, 'x'.repeat(35_000)), file(4)];
    const batches = partitionPullReviewFiles(files);
    expect(batches.map((batch) => batch.paths.length)).toEqual([2, 1, 1]);
    expect(batches.flatMap((batch) => batch.paths)).toEqual(files.map((entry) => entry.filename));
    expect(batches[1]?.patchChars).toBe(35_000);
  });

  it('keeps generated files out of a reviewer batch and bounds them by count alone', () => {
    const named = (filename: string, patch = '+small'): GitHubPullFile =>
      ({ filename, status: 'modified', additions: 1, deletions: 0, patch }) as GitHubPullFile;
    const listed = [
      named('package-lock.json', 'x'.repeat(REVIEW_TARGET_PATCH_CHARS * 4)),
      named('package.json'),
      named('packages/cli/THIRD_PARTY_NOTICES.txt', 'x'.repeat(REVIEW_TARGET_PATCH_CHARS)),
      named('packages/cli/package.json'),
    ];
    const ordered = orderPullReviewFiles(listed);
    expect(ordered.map((entry) => entry.filename)).toEqual([
      'package.json',
      'packages/cli/package.json',
      'package-lock.json',
      'packages/cli/THIRD_PARTY_NOTICES.txt',
    ]);
    expect(partitionPullReviewFiles(ordered)).toEqual([
      expect.objectContaining({ start: 1, end: 2 }),
      expect.objectContaining({ start: 3, end: 4, generated: true }),
    ]);
    expect(partitionPullReviewFiles(ordered)[0]).not.toHaveProperty('generated');
    // Left in listing order, the same files cost a reviewer three batches.
    expect(partitionPullReviewFiles(listed).map((batch) => batch.generated ?? false)).toEqual([
      true,
      false,
      true,
      false,
    ]);
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
    expect(overview.bodyMarkdown).toContain('## Review batches');
    // The full diff rides along as an attachment so a reviewer can read the
    // whole change without one record per hunk.
    expect(overview.attachments?.[0]?.filename).toBe('pr-52.diff');
    expect(overview.attachments?.[1]?.filename).toBe('pr-52-files.json');
    const manifest = JSON.parse(new TextDecoder().decode(overview.attachments?.[1]?.content)) as {
      files: Array<{ path: string; recordHash: string }>;
    };
    expect(manifest.files[0]).toMatchObject({
      path: 'src/auth.ts',
      recordHash: sha8('pr-52-file-src/auth.ts'),
      ordinal: 1,
      status: 'modified',
      additions: 3,
      deletions: 1,
    });

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

  // GitHub refuses a diff past its file limit every time. Every sync pass
  // asked again and warned again, 10-23 times an hour (2026-10-09).
  it('asks GitHub once for a diff it refused as too large', async () => {
    let asked = 0;
    const rt = runtime();
    rt.prs.getPullRequestDiff = async () => {
      asked++;
      throw new Error('HttpError: Sorry, the diff exceeded the maximum number of files (300).');
    };
    for (let pass = 0; pass < 3; pass++) {
      const adapter = new GitHubPullsAdapter(binding(), deps(), rt);
      await adapter.ensureAuth();
      await adapter.listChangesSince('pr-901', undefined);
    }
    expect(asked).toBe(1);
  });

  it('replaces a list-files patch prefix with the complete full-diff segment', async () => {
    const adapter = new GitHubPullsAdapter(
      binding(),
      deps(),
      runtime({
        files: [
          {
            filename: 'src/auth.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            patch: '@@ -1 +1,2 @@\n-old\n+early-prefix',
          },
        ],
        diff: [
          'diff --git a/src/auth.ts b/src/auth.ts',
          '--- a/src/auth.ts',
          '+++ b/src/auth.ts',
          '@@ -1 +1,2 @@',
          '-old',
          '+early-prefix',
          '+late-line-from-full-diff',
        ].join('\n'),
      }),
    );
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('pr-52', undefined);
    const file = await adapter.fetchRecord('pr-52', batch.records[1]!);
    expect(file.bodyMarkdown).toContain('late-line-from-full-diff');
  });

  it('prints each patch line with its new-file number, so nobody counts a hunk', async () => {
    const adapter = new GitHubPullsAdapter(
      binding(),
      deps(),
      runtime({
        files: [
          {
            filename: 'src/auth.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -40,3 +41,3 @@\n context\n-old\n+new\n tail',
          },
          {
            filename: 'src/gone.ts',
            status: 'removed',
            additions: 0,
            deletions: 1,
            patch: '@@ -1 +0,0 @@\n-only',
          },
        ],
      }),
    );
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('pr-52', undefined);
    const file = await adapter.fetchRecord('pr-52', batch.records[1]!);
    expect(file.bodyMarkdown).toContain(PATCH_LINE_LEGEND);
    expect(file.bodyMarkdown).toContain(
      ['@@ -40,3 +41,3 @@', '41  context', '   -old', '42 +new', '43  tail', '```'].join('\n'),
    );
    expect([...parsePatchRecord(file.bodyMarkdown)!.newLines]).toEqual([41, 42, 43]);
    // A deleted file has no new-file lines: nothing to number, so no legend.
    const gone = await adapter.fetchRecord('pr-52', batch.records[2]!);
    expect(gone.bodyMarkdown).toContain('-only');
    expect(gone.bodyMarkdown).not.toContain(PATCH_LINE_LEGEND);
  });

  it('lists generated files last and marks them for the runtime to summarize', async () => {
    const adapter = new GitHubPullsAdapter(
      binding(),
      deps(),
      runtime({
        files: [
          { filename: 'package-lock.json', status: 'modified', additions: 9, deletions: 9 },
          { filename: 'src/auth.ts', status: 'modified', additions: 1, deletions: 0 },
        ],
      }),
    );
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('pr-52', undefined);
    expect(batch.records.map((r) => r.id)).toEqual([
      'pr-52',
      'pr-52-file-src/auth.ts',
      'pr-52-file-package-lock.json',
    ]);
    const overview = await adapter.fetchRecord('pr-52', batch.records[0]!);
    const manifest = JSON.parse(new TextDecoder().decode(overview.attachments?.[1]?.content)) as {
      batches: Array<{ batchNumber: number; paths: string[]; generated?: boolean }>;
      files: Array<{ path: string; ordinal: number; generated?: string }>;
    };
    expect(manifest.batches).toEqual([
      expect.objectContaining({ batchNumber: 1, paths: ['src/auth.ts'] }),
      expect.objectContaining({ batchNumber: 2, paths: ['package-lock.json'], generated: true }),
    ]);
    expect(manifest.batches[0]).not.toHaveProperty('generated');
    expect(manifest.files).toEqual([
      expect.objectContaining({ path: 'src/auth.ts', ordinal: 1 }),
      expect.objectContaining({ path: 'package-lock.json', ordinal: 2, generated: 'lockfile' }),
    ]);
    expect(overview.bodyMarkdown).toContain(
      '- Batch 2: files 2–2 (1 path, generated files the runtime summarizes)',
    );
    const lock = await adapter.fetchRecord('pr-52', batch.records[2]!);
    expect(lock.frontmatter.generated).toBe('lockfile');
  });

  it('re-syncs nothing while the pull request is unchanged', async () => {
    const adapter = new GitHubPullsAdapter(binding(), deps(), runtime());
    await adapter.ensureAuth();
    const first = await adapter.listChangesSince('pr-52', undefined);
    const second = await adapter.listChangesSince('pr-52', first.cursor);
    expect(second.records).toEqual([]);
  });

  it('an unchanged pull request costs one detail call on the next pass, not the whole bundle', async () => {
    const rt = runtime();
    const calls: string[] = [];
    for (const key of [
      'getPullRequest',
      'listFiles',
      'listComments',
      'getPullRequestDiff',
    ] as const) {
      const real = rt.prs[key] as (...args: unknown[]) => Promise<unknown>;
      (rt.prs as Record<string, unknown>)[key] = (...args: unknown[]) => {
        calls.push(key);
        return real(...args);
      };
    }
    const first = new GitHubPullsAdapter(binding(), deps(), rt);
    await first.ensureAuth();
    const batch = await first.listChangesSince('pr-52', undefined);
    calls.length = 0;
    // A later pass is a fresh adapter with nothing cached.
    const next = new GitHubPullsAdapter(binding(), deps(), rt);
    await next.ensureAuth();
    const again = await next.listChangesSince('pr-52', batch.cursor);
    expect(again.records).toEqual([]);
    expect(calls).toEqual(['getPullRequest']);
  });

  it('pages a pull request larger than one batch instead of dropping files', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    }));
    const adapter = new GitHubPullsAdapter(binding(), deps(), runtime({ files }));
    await adapter.ensureAuth();
    const seen: string[] = [];
    let cursor: unknown;
    let pages = 0;
    for (;;) {
      const batch = await adapter.listChangesSince('pr-52', cursor, { limit: 3 });
      pages++;
      seen.push(...batch.records.map((r) => r.id));
      cursor = batch.cursor;
      expect(batch.records.length).toBeLessThanOrEqual(3);
      if (!batch.partial) break;
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(8); // the overview plus seven files
    const quiet = await adapter.listChangesSince('pr-52', cursor, { limit: 3 });
    expect(quiet.records).toEqual([]);
  });

  it('drops the record of a file that left the pull request', async () => {
    const env = await createConnectorTestEnv();
    try {
      const file = (filename: string) => ({
        filename,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      });
      let files = [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')];
      const pass = async (cursor: unknown) =>
        syncWithAdapter(
          new GitHubPullsAdapter(binding(), env.deps(), {
            ...runtime(),
            ...{ prs: { ...runtime({ files }).prs } },
          }),
          {
            storageDir: env.artifactsDir,
            quarantineDir: env.quarantineDir,
            corpusDir: 'data/prs',
            backfillLimit: 2,
            cursor,
            scopes: ['pr-52'],
          },
        );
      const first = await pass(undefined);
      const second = await pass(first.cursor);
      expect((await readCorpus(env.artifactsDir, 'data/prs')).length).toBe(4);
      // A force-push drops b.ts from the pull request.
      files = [file('src/a.ts'), file('src/c.ts')];
      let cursor = second.cursor;
      for (let i = 0; i < 3; i++) cursor = (await pass(cursor)).cursor;
      const titles = (await readCorpus(env.artifactsDir, 'data/prs')).map((r) => r.path);
      expect(titles).toHaveLength(3);
      expect(titles.some((p) => p.includes('b-ts'))).toBe(false);
    } finally {
      await env.dispose();
    }
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

    const synced: {
      bindingId: string;
      scopes?: readonly string[];
      backfillLimit?: number;
    }[] = [];
    const result = await prep!({
      project: project(),
      binding: { id: 'pulls-binding', type: 'github-pulls', corpusDir: 'data/github-pulls' },
      params: {},
      sync: async (bindingId, opts) => {
        synced.push({
          bindingId,
          ...(opts?.scopes ? { scopes: opts.scopes } : {}),
          ...(opts?.backfillLimit ? { backfillLimit: opts.backfillLimit } : {}),
        });
        return { written: 2, quarantined: 0, skipped: 0, pruned: 0, errors: 0, cursor: undefined };
      },
    });

    expect(synced).toEqual([
      { bindingId: 'pulls-binding', scopes: ['pr-52'], backfillLimit: 3_001 },
    ]);
    expect(result.params).toEqual({
      number: '52',
      corpusScope: 'data/github-pulls/pr-52',
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

  it('fails the launch when one targeted record did not sync', async () => {
    registerGitHubPullsAdapters(runtime());
    const prep = connectorTaskPrepFor('github-pulls');
    await expect(
      prep!({
        project: project(),
        binding: { id: 'pulls-binding', type: 'github-pulls', corpusDir: 'data/github-pulls' },
        params: {},
        sync: async () => ({
          written: 1,
          quarantined: 0,
          skipped: 0,
          pruned: 0,
          errors: 1,
          cursor: undefined,
        }),
      }),
    ).rejects.toThrow(/Could not pull down PR #52: 1 record failed to sync/);
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

  // The launch bug this guards: `project.github.branch` is the *configured*
  // tracking branch and is unset on most links, so reading it instead of
  // HEAD turned every "review the PR for this branch" launch into "the
  // checkout has no branch" — a 409 on projects that were on a branch the
  // whole time.
  it('resolves against live HEAD, not the link’s pinned branch', async () => {
    const rt = runtime({
      currentBranch: 'bugfix-y',
      open: [
        { number: 41, headRef: 'feature-x' },
        { number: 52, headRef: 'bugfix-y' },
      ],
    });
    expect(await resolveLaunchPullNumber(rt, project(), {})).toBe(52);
  });

  it('falls back to the pinned branch when HEAD is unreadable', async () => {
    const rt = runtime({
      currentBranch: null,
      open: [
        { number: 41, headRef: 'someone-else' },
        { number: 52, headRef: 'feature-x' },
      ],
    });
    expect(await resolveLaunchPullNumber(rt, project(), {})).toBe(52);
  });

  it('names no branch only when neither HEAD nor the link has one', async () => {
    const rt = runtime({ currentBranch: null, open: [{ number: 41, headRef: 'someone-else' }] });
    await expect(
      resolveLaunchPullNumber(rt, project({ github: { url: 'https://github.com/x/y' } }), {}),
    ).rejects.toThrow(/the project checkout has no branch/);
  });
});
