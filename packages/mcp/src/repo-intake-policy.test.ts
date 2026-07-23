import { describe, expect, it } from 'vitest';
import { extractGitHubRepoUrl, repoIntakeRedirect } from './repo-intake-policy.js';

describe('repo intake policy', () => {
  it('normalizes GitHub repository URLs to the clone root', () => {
    expect(extractGitHubRepoUrl('Review https://github.com/bendyline/squisq/pull/42.')).toBe(
      'https://github.com/bendyline/squisq',
    );
    expect(extractGitHubRepoUrl('Clone https://github.com/Example/Widget.git now')).toBe(
      'https://github.com/Example/Widget',
    );
  });

  it('redirects empty project macros for remote repository reviews', () => {
    const redirect = repoIntakeRedirect({
      tool: 'start_project',
      mode: 'macro',
      projectName: 'Squisq Code Review',
      text: [
        'Please conduct a comprehensive architecture and code review of the open-source repository',
        'at https://github.com/bendyline/squisq.',
      ].join(' '),
    });

    expect(redirect?.url).toBe('https://github.com/bendyline/squisq');
    expect(redirect?.message).toContain('start_project is the wrong macro');
    expect(redirect?.message).toContain(
      'fetch_repo({ url: "https://github.com/bendyline/squisq", projectName: "Squisq Code Review" })',
    );
  });

  it('redirects reviewer handoff before the repo exists in the project workspace', () => {
    const redirect = repoIntakeRedirect({
      tool: 'delegate_reviewer',
      mode: 'handoff',
      text: 'Review https://github.com/bendyline/squisq and write review.md with source citations.',
    });

    expect(redirect?.projectName).toBe('Squisq Code Review');
    expect(redirect?.message).toContain('cannot hand off remote repository work');
    expect(redirect?.message).toContain('pass the returned projectId');
  });

  it('does not redirect ordinary build work that only mentions a GitHub link', () => {
    expect(
      repoIntakeRedirect({
        tool: 'start_project',
        mode: 'macro',
        text: 'Build a simple landing page with a footer link to https://github.com/bendyline/squisq.',
      }),
    ).toBeNull();
  });
});
