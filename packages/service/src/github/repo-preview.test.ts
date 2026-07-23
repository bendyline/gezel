import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repo-preview module instantiates Octokit via `new Octokit(...)`.
 * We mock the constructor so we don't make network calls — each test
 * sets the responses for `repos.get` and `repos.getReadme`.
 */

const reposGet = vi.fn();
const reposGetReadme = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function MockOctokit() {
    return {
      repos: { get: reposGet, getReadme: reposGetReadme },
    };
  }),
}));

beforeEach(() => {
  reposGet.mockReset();
  reposGetReadme.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('previewGithubRepo', () => {
  it('returns metadata + decoded README for a public repo', async () => {
    reposGet.mockResolvedValue({
      data: {
        description: 'Hello World!',
        default_branch: 'main',
        topics: ['demo', 'test'],
        language: 'TypeScript',
      },
    });
    reposGetReadme.mockResolvedValue({
      data: {
        content: Buffer.from('# Hello\nThis is a README.', 'utf8').toString('base64'),
        encoding: 'base64',
      },
    });
    const { previewGithubRepo } = await import('./repo-preview.js');
    const result = await previewGithubRepo(null, 'https://github.com/octocat/Hello-World');
    expect(result.owner).toBe('octocat');
    expect(result.repo).toBe('Hello-World');
    expect(result.canonicalUrl).toBe('https://github.com/octocat/Hello-World');
    expect(result.description).toBe('Hello World!');
    expect(result.defaultBranch).toBe('main');
    expect(result.topics).toEqual(['demo', 'test']);
    expect(result.language).toBe('TypeScript');
    expect(result.readme).toBe('# Hello\nThis is a README.');
    expect(result.readmeTruncated).toBe(false);
  });

  it('truncates large READMEs and flags it', async () => {
    reposGet.mockResolvedValue({ data: { default_branch: 'main' } });
    const big = 'x'.repeat(20_000);
    reposGetReadme.mockResolvedValue({
      data: { content: Buffer.from(big, 'utf8').toString('base64'), encoding: 'base64' },
    });
    const { previewGithubRepo } = await import('./repo-preview.js');
    const result = await previewGithubRepo(null, 'https://github.com/o/r');
    expect(result.readmeTruncated).toBe(true);
    expect(result.readme.length).toBeLessThan(big.length);
  });

  it('treats a missing README as empty rather than throwing', async () => {
    reposGet.mockResolvedValue({ data: { default_branch: 'main' } });
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    reposGetReadme.mockRejectedValue(notFound);
    const { previewGithubRepo } = await import('./repo-preview.js');
    const result = await previewGithubRepo(null, 'https://github.com/o/r');
    expect(result.readme).toBe('');
    expect(result.readmeTruncated).toBe(false);
  });

  it('rejects an unparseable URL', async () => {
    const { previewGithubRepo, InvalidGithubUrlError } = await import('./repo-preview.js');
    await expect(previewGithubRepo(null, 'https://example.com/foo')).rejects.toBeInstanceOf(
      InvalidGithubUrlError,
    );
  });

  it('surfaces 404 from repos.get as GithubRepoNotFoundError', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    reposGet.mockRejectedValue(notFound);
    const { previewGithubRepo, GithubRepoNotFoundError } = await import('./repo-preview.js');
    await expect(previewGithubRepo(null, 'https://github.com/o/r')).rejects.toBeInstanceOf(
      GithubRepoNotFoundError,
    );
  });

  it('maps 401 from repos.get to GithubAccessDeniedError', async () => {
    const unauth = Object.assign(new Error('unauthorized'), { status: 401 });
    reposGet.mockRejectedValue(unauth);
    const { previewGithubRepo, GithubAccessDeniedError } = await import('./repo-preview.js');
    await expect(previewGithubRepo('ghp_token', 'https://github.com/o/r')).rejects.toBeInstanceOf(
      GithubAccessDeniedError,
    );
  });

  it('maps 403 from repos.get to GithubAccessDeniedError with a scope hint', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    reposGet.mockRejectedValue(forbidden);
    const { previewGithubRepo, GithubAccessDeniedError } = await import('./repo-preview.js');
    try {
      await previewGithubRepo('ghp_token', 'https://github.com/o/r');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAccessDeniedError);
      expect((err as InstanceType<typeof GithubAccessDeniedError>).status).toBe(403);
      expect((err as Error).message).toMatch(/scope|OAuth/i);
    }
  });

  it('surfaces an OAuth-App-restrictions 403 with the org approval link', async () => {
    const githubMessage =
      'Although you appear to have the correct authorization credentials, the `acme-org` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
    const forbidden = Object.assign(new Error(githubMessage), {
      status: 403,
      response: { data: { message: githubMessage } },
    });
    reposGet.mockRejectedValue(forbidden);
    const { previewGithubRepo, GithubAccessDeniedError } = await import('./repo-preview.js');
    try {
      await previewGithubRepo('ghp_token', 'https://github.com/acme-org/private-repo');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAccessDeniedError);
      const denied = err as InstanceType<typeof GithubAccessDeniedError>;
      expect(denied.message).toContain(githubMessage);
      // Includes the specific org name from the URL in the fix URL.
      expect(denied.fixUrl).toMatch(/connections\/applications\//);
    }
  });
});
