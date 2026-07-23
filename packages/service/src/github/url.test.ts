import { describe, expect, it } from 'vitest';
import { authenticatedCloneUrl, parseGithubUrl, sameGithubRepo, sharedCloneKey } from './url.js';

describe('parseGithubUrl', () => {
  it('parses an https URL with .git suffix', () => {
    const p = parseGithubUrl('https://github.com/octocat/Hello-World.git');
    expect(p).toMatchObject({
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
      canonical: 'https://github.com/octocat/Hello-World',
      cloneUrl: 'https://github.com/octocat/Hello-World.git',
    });
  });

  it('parses an https URL without .git suffix', () => {
    const p = parseGithubUrl('https://github.com/octocat/Hello-World');
    expect(p?.repo).toBe('Hello-World');
    expect(p?.cloneUrl).toBe('https://github.com/octocat/Hello-World.git');
  });

  it('parses a trailing-slashed URL', () => {
    const p = parseGithubUrl('https://github.com/octocat/Hello-World/');
    expect(p?.repo).toBe('Hello-World');
  });

  it('parses an ssh-style URL', () => {
    const p = parseGithubUrl('git@github.com:octocat/Hello-World.git');
    expect(p).toMatchObject({
      host: 'github.com',
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('parses a schemeless URL', () => {
    const p = parseGithubUrl('github.com/octocat/Hello-World');
    expect(p?.host).toBe('github.com');
  });

  it('handles enterprise hosts', () => {
    const p = parseGithubUrl('https://github.bendyline.com/teams/internal.git');
    expect(p?.host).toBe('github.bendyline.com');
    expect(p?.owner).toBe('teams');
    expect(p?.repo).toBe('internal');
  });

  it('returns null for clearly non-repo URLs', () => {
    // Only one path segment after the host — not a repo.
    expect(parseGithubUrl('https://example.com/whatever')).toBeNull();
    expect(parseGithubUrl('not a url')).toBeNull();
    expect(parseGithubUrl('')).toBeNull();
  });
});

describe('sameGithubRepo', () => {
  it('treats https and ssh forms as equal', () => {
    expect(
      sameGithubRepo(
        'https://github.com/octocat/Hello-World.git',
        'git@github.com:octocat/Hello-World.git',
      ),
    ).toBe(true);
  });

  it('is case-insensitive on owner/repo', () => {
    expect(
      sameGithubRepo(
        'https://github.com/Octocat/HELLO-world',
        'git@github.com:octocat/hello-WORLD.git',
      ),
    ).toBe(true);
  });

  it('rejects different repos', () => {
    expect(
      sameGithubRepo(
        'https://github.com/octocat/Hello-World',
        'https://github.com/octocat/Goodbye-World',
      ),
    ).toBe(false);
  });

  it('rejects different hosts', () => {
    expect(
      sameGithubRepo(
        'https://github.com/octocat/Hello-World',
        'https://github.bendyline.com/octocat/Hello-World',
      ),
    ).toBe(false);
  });
});

describe('authenticatedCloneUrl', () => {
  it('injects an x-access-token user', () => {
    const url = authenticatedCloneUrl('https://github.com/o/r.git', 'ghp_abc');
    expect(url).toBe('https://x-access-token:ghp_abc@github.com/o/r.git');
  });

  it('passes through when no token is given', () => {
    expect(authenticatedCloneUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(authenticatedCloneUrl('https://github.com/o/r.git', null)).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('replaces an existing user prefix', () => {
    const url = authenticatedCloneUrl('https://stale@github.com/o/r.git', 'ghp_abc');
    expect(url).toBe('https://x-access-token:ghp_abc@github.com/o/r.git');
  });

  it('encodes special characters in the token', () => {
    const url = authenticatedCloneUrl('https://github.com/o/r.git', 'ghp/with@chars');
    expect(url).toContain('x-access-token:ghp%2Fwith%40chars@github.com');
  });

  it('does not touch non-https URLs', () => {
    expect(authenticatedCloneUrl('git@github.com:o/r.git', 'ghp')).toBe('git@github.com:o/r.git');
  });
});

describe('sharedCloneKey', () => {
  it('produces a stable greppable key for github URLs', () => {
    // Dots in the hostname get slugified to dashes — `github.com` →
    // `github-com` — so the key is safe to use as a directory name on
    // every filesystem we care about.
    expect(sharedCloneKey('https://github.com/bendyline/squisq')).toMatch(
      /^github-com-bendyline-squisq-[0-9a-f]{8}$/,
    );
  });

  it('two URL forms for the same repo produce the same key', () => {
    const a = sharedCloneKey('https://github.com/bendyline/squisq');
    const b = sharedCloneKey('git@github.com:bendyline/squisq.git');
    const c = sharedCloneKey('https://github.com/bendyline/squisq.git/');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('different repos produce different keys', () => {
    const a = sharedCloneKey('https://github.com/bendyline/squisq');
    const b = sharedCloneKey('https://github.com/bendyline/gezel');
    expect(a).not.toBe(b);
  });

  it('case-insensitive on owner/repo (matches sameGithubRepo)', () => {
    const a = sharedCloneKey('https://github.com/BendyLine/Squisq');
    const b = sharedCloneKey('https://github.com/bendyline/squisq');
    expect(a).toBe(b);
  });

  it('falls back to a local- prefix for filesystem paths', () => {
    expect(sharedCloneKey('/tmp/some/local/upstream.git')).toMatch(/^local-[0-9a-f]{8}$/);
  });

  it('treats gitlab-shaped URLs as github-like (permissive parser)', () => {
    // `parseGithubUrl` accepts any `host/owner/repo` shape via its
    // schemeless regex — gitlab URLs share the same shape as github
    // and get the full slug-with-host key. This is fine because the
    // key only needs to be STABLE per repo; the github-specific
    // handling (PAT auth, github API) is gated separately.
    expect(sharedCloneKey('https://gitlab.example.com/team/proj')).toMatch(
      /^gitlab-example-com-team-proj-[0-9a-f]{8}$/,
    );
  });

  it('returns null only for empty / whitespace-only input', () => {
    expect(sharedCloneKey('')).toBeNull();
    expect(sharedCloneKey('   ')).toBeNull();
  });
});
