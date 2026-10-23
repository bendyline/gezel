import { describe, expect, it } from 'vitest';
import type { IssueHandoffResponse } from '../schemas/api/issue-triage.js';
import { HARNESS_TOOL_NAMES } from './harness-profile.js';
import {
  harnessPromptCount,
  harnessPromptInvocation,
  renderEmptyIssuePrompt,
  renderHarnessIssuePrompt,
  renderIssueBatch,
} from './harness-prompts.js';

const queue: IssueHandoffResponse = {
  files: [
    {
      path: 'src/save.ts',
      issues: [
        {
          ref: 'BW-4',
          severity: 'major',
          category: 'bug',
          message: 'Off by one.',
          line: 12,
          stale: false,
        },
        {
          ref: 'BW-6',
          severity: 'minor',
          category: 'bug',
          message: 'Unchecked null.',
          stale: true,
          verdict: 'unsure',
          verdictNote: 'Depends on the caller.',
        },
      ],
    },
  ],
  count: 2,
  remaining: 0,
  firstBatch: true,
  indexed: true,
};

describe('the issue prompts outside apps run', () => {
  it('names the slash command only for apps known to show prompts', () => {
    expect(harnessPromptInvocation('claude-code', 'triage_issues')).toBe(
      '/mcp__gezel__triage_issues',
    );
    expect(harnessPromptInvocation('vscode', 'fix_issues')).toBe('/mcp.gezel.fix_issues');
    expect(harnessPromptInvocation('cursor', 'triage_issues')).toBeNull();
  });

  it('reads the count argument as a bounded number', () => {
    expect(harnessPromptCount('triage_issues', undefined)).toBe(10);
    expect(harnessPromptCount('fix_issues', 'abc')).toBe(5);
    expect(harnessPromptCount('triage_issues', '500')).toBe(50);
    expect(harnessPromptCount('triage_issues', '7')).toBe(7);
  });

  it('renders a batch with absolute paths, moved lines and earlier verdicts', () => {
    const text = renderIssueBatch(queue, (rel) => `/repo/${rel}`);
    expect(text).toContain('/repo/src/save.ts');
    expect(text).toContain('- BW-4 · major · bug · line 12: Off by one.');
    expect(text).toContain('the file changed since the review');
    expect(text).toContain('Earlier verdict: unsure (Depends on the caller.)');
  });

  it('says plainly when there is nothing to check', () => {
    expect(renderIssueBatch({ ...queue, files: [], count: 0 }, (r) => r)).toMatch(/no open issues/);
    expect(renderIssueBatch({ ...queue, files: [], count: 0, indexed: false }, (r) => r)).toMatch(
      /hasn't indexed/,
    );
  });

  it('says there is nothing to check, and only that, when the batch is empty', () => {
    const empty = renderEmptyIssuePrompt(
      'Gezel has no open issues for this folder that need checking.',
    );
    expect(empty).toMatch(/^Gezel has no open issues/);
    expect(empty).toContain('stop');
    expect(empty).not.toContain('report_issue_verdicts');
  });

  it('tells triage not to edit and fixing to run the tests, naming only profile tools', () => {
    const triage = renderHarnessIssuePrompt('triage_issues', 'BATCH');
    const fix = renderHarnessIssuePrompt('fix_issues', 'BATCH');
    expect(triage).toContain("Don't change any code");
    expect(fix).toContain('run the tests that cover it');
    expect(triage.endsWith('BATCH')).toBe(true);
    const named = [...triage.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    for (const tool of named) expect(HARNESS_TOOL_NAMES).toContain(tool);
  });
});
