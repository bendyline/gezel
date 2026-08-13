import { describe, expect, it } from 'vitest';
import {
  formatWorkspaceIssueFixMessage,
  inferWorkspaceIssueFixRole,
} from './WorkspaceIssueFixDialog.js';

const trackedIssue = {
  ref: 'BW-12',
  id: 'issue-12',
  fingerprint: 'fingerprint-12',
  path: 'src/server.ts',
  severity: 'major' as const,
  category: 'bug',
  message: 'The fallback loops forever.',
  line: 26,
  status: 'open' as const,
  seen: false,
  stale: false,
  createdAt: '2026-08-12T00:00:00.000Z',
  lastSeenAt: '2026-08-12T00:00:00.000Z',
};

describe('workspace issue fix routing', () => {
  it.each([
    ['docs/guide.md', 'writer'],
    ['src/server.ts', 'developer'],
    ['assets/logo.svg', 'designer'],
    ['data/results.csv', 'researcher'],
    ['Dockerfile', 'developer'],
  ] as const)('routes %s to the %s role', (path, role) => {
    expect(inferWorkspaceIssueFixRole(path)).toBe(role);
  });

  it('includes the selected role and structured line anchor in the message', () => {
    expect(formatWorkspaceIssueFixMessage('src/server.ts', trackedIssue, 'developer')).toBe(
      '@developer, can you address BW-12 in src/server.ts at line 26: The fallback loops forever.',
    );
  });

  it('omits the location when the review did not provide one', () => {
    expect(
      formatWorkspaceIssueFixMessage(
        'README.md',
        {
          ...trackedIssue,
          path: 'README.md',
          severity: 'minor',
          category: 'clarity',
          message: 'The heading is ambiguous.',
          line: undefined,
        },
        'writer',
      ),
    ).toBe('@writer, can you address BW-12 in README.md: The heading is ambiguous.');
  });

  it('labels the old line as historical after the file changed', () => {
    expect(
      formatWorkspaceIssueFixMessage(
        'src/server.ts',
        { ...trackedIssue, stale: true },
        'developer',
      ),
    ).toContain(
      'It was previously reported near line 26. The file has changed since this was reported',
    );
  });
});
