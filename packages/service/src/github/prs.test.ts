import { describe, expect, it } from 'vitest';
import { filterUnifiedDiffByPath, sliceTextPage } from './prs.js';

const DIFF = [
  'diff --git a/src/early.ts b/src/early.ts',
  '--- a/src/early.ts',
  '+++ b/src/early.ts',
  '@@ -1 +1 @@',
  '-old',
  '+early',
  'diff --git a/src/late api.ts b/src/late api.ts',
  '--- a/src/late api.ts',
  '+++ b/src/late api.ts',
  '@@ -1 +1 @@',
  '-old',
  '+export function assuredApi() {}',
  '',
].join('\n');

describe('pull-request review paging', () => {
  it('reports an explicit continuation until every character was delivered', () => {
    const first = sliceTextPage('abcdefghij', 0, 4);
    expect(first).toEqual({
      diff: 'abcd',
      offset: 0,
      returnedChars: 4,
      totalChars: 10,
      truncated: true,
      nextOffset: 4,
    });

    const last = sliceTextPage('abcdefghij', first.nextOffset, 20);
    expect(last).toMatchObject({
      diff: 'efghij',
      offset: 4,
      returnedChars: 6,
      totalChars: 10,
      truncated: false,
    });
    expect(last.nextOffset).toBeUndefined();
  });

  it('can retrieve a late changed path without sending the early prefix', () => {
    const selected = filterUnifiedDiffByPath(DIFF, 'src/late api.ts');
    expect(selected).toContain('assuredApi');
    expect(selected).not.toContain('early.ts');
  });

  it('returns an empty selection for a path that is not in the PR', () => {
    expect(filterUnifiedDiffByPath(DIFF, 'src/missing.ts')).toBe('');
  });
});

describe('pull-request comments', () => {
  /** GitHub pages lists with `per_page` and a `Link: <…>; rel="next"` header. */
  function pagedComments(counts: { issue: number; review: number }): typeof fetch {
    return async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const review = url.pathname.endsWith('/pulls/7/comments');
      const total = review ? counts.review : counts.issue;
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const start = (page - 1) * perPage;
      const items = Array.from(
        { length: Math.max(0, Math.min(perPage, total - start)) },
        (_, i) => ({
          id: (review ? 100_000 : 0) + start + i,
          user: { login: 'ada' },
          body: `${review ? 'review' : 'issue'} comment ${start + i}`,
          created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, start + i)).toISOString(),
          ...(review ? { path: 'src/a.ts' } : {}),
        }),
      );
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (start + perPage < total) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return new Response(JSON.stringify(items), { status: 200, headers });
    };
  }

  it('reads every page of both kinds, not only the first hundred', async () => {
    const { GitHubPrs } = await import('./prs.js');
    const manager = { getToken: async () => 'token' } as unknown as ConstructorParameters<
      typeof GitHubPrs
    >[0];
    const prs = new GitHubPrs(manager, { fetch: pagedComments({ issue: 230, review: 120 }) });
    const project = { id: 'p', github: { url: 'https://github.com/acme/widgets' } } as never;
    const comments = await prs.listComments(project, 7);
    expect(comments.filter((c) => c.kind === 'issue')).toHaveLength(230);
    expect(comments.filter((c) => c.kind === 'review')).toHaveLength(120);
  });
});
