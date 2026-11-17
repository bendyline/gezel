import { describe, expect, it } from 'vitest';
import {
  type PromptConnectorRule,
  WEB_PAGE_RULE,
  findPromptConnectorCandidates,
  promptConnectorCandidateFor,
  promptConnectorKey,
} from './index.js';

/** A rule of the kind a GitHub connector would add: more specific than a page. */
const REPO_RULE: PromptConnectorRule = {
  id: 'github-repo',
  connectorType: 'github-issues',
  effect: 'connect',
  find: ({ urls }) =>
    urls.flatMap((url) => {
      const u = new URL(url);
      const [owner, repo] = u.pathname.split('/').filter(Boolean);
      return u.hostname === 'github.com' && owner && repo
        ? [{ subject: url, label: `${owner}/${repo}` }]
        : [];
    }),
};

describe('findPromptConnectorCandidates', () => {
  it('offers each web address in a draft as a page to include', () => {
    expect(
      findPromptConnectorCandidates('Can you summarize www.microsoft.com and gezel.com? No.'),
    ).toEqual([
      {
        rule: 'web-page',
        connectorType: 'website',
        effect: 'include',
        subject: 'https://www.microsoft.com/',
        label: 'www.microsoft.com',
      },
    ]);
    expect(
      findPromptConnectorCandidates('See https://gezel.com/platform?ref=a and nothing else')[0],
    ).toMatchObject({ subject: 'https://gezel.com/platform?ref=a', label: 'gezel.com/platform?…' });
  });

  it('finds nothing in a draft with no address', () => {
    expect(findPromptConnectorCandidates('What should we have for dinner?')).toEqual([]);
  });

  it('lets a more specific rule claim an address before the page rule', () => {
    const found = findPromptConnectorCandidates(
      'Compare https://github.com/bendyline/gezel with https://gezel.com/platform',
      { rules: [REPO_RULE, WEB_PAGE_RULE] },
    );
    expect(found.map((c) => [c.rule, c.label])).toEqual([
      ['github-repo', 'bendyline/gezel'],
      ['web-page', 'gezel.com/platform'],
    ]);
    expect(found[0]?.effect).toBe('connect');
  });

  it('shows at most three, so a person can read what Send will do', () => {
    const text = [1, 2, 3, 4, 5].map((n) => `https://site${n}.test/`).join(' ');
    expect(findPromptConnectorCandidates(text)).toHaveLength(3);
  });
});

describe('promptConnectorCandidateFor', () => {
  it('rebuilds a candidate from its rule and subject, and refuses a subject the rule does not claim', () => {
    const c = promptConnectorCandidateFor('web-page', 'https://gezel.com/platform');
    expect(c).toMatchObject({ connectorType: 'website', label: 'gezel.com/platform' });
    expect(c && promptConnectorKey(c)).toBe('web-page:https://gezel.com/platform');
    expect(promptConnectorCandidateFor('web-page', 'file:///etc/passwd')).toBeNull();
    expect(promptConnectorCandidateFor('web-page', 'not an address')).toBeNull();
    expect(promptConnectorCandidateFor('no-such-rule', 'https://gezel.com/')).toBeNull();
  });
});
