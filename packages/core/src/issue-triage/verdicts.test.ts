import { describe, expect, it } from 'vitest';
import { IssueVerdictInputSchema } from '../schemas/api/issue-triage.js';
import {
  BoekwachterIssueSchema,
  ISSUE_VERDICT_KINDS,
  IssueVerdictSummarySchema,
} from '../schemas/file-review.js';
import {
  ISSUE_VERDICT_DEFINITIONS,
  issueVerdictActorLabel,
  issueVerdictClass,
  issueVerdictLifecycle,
} from './verdicts.js';

describe('the issue verdict vocabulary', () => {
  it('closes what is settled and leaves open what still needs work', () => {
    expect(issueVerdictLifecycle('fixed')).toEqual({ status: 'resolved' });
    expect(issueVerdictLifecycle('not_a_bug')).toEqual({
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
    });
    expect(issueVerdictLifecycle('nit')).toEqual({
      status: 'dismissed',
      dismissalReason: 'wont_fix',
    });
    expect(issueVerdictLifecycle('duplicate').dismissalReason).toBe('duplicate');
    expect(issueVerdictLifecycle('confirmed')).toEqual({ status: 'open' });
    expect(issueVerdictLifecycle('unsure')).toEqual({ status: 'open' });
  });

  it('counts a nit as a valid lead and only not-a-bug as wrong', () => {
    expect(issueVerdictClass('nit')).toBe('valid');
    expect(issueVerdictClass('confirmed')).toBe('actionable');
    expect(issueVerdictClass('not_a_bug')).toBe('wrong');
    expect(issueVerdictClass('unsure')).toBe('undecided');
    expect(issueVerdictClass('recurred')).toBe('undecided');
  });

  it('defines every verdict an outside app may send', () => {
    for (const kind of ISSUE_VERDICT_KINDS) expect(ISSUE_VERDICT_DEFINITIONS[kind]).toBeTruthy();
  });

  it('names who decided in plain words', () => {
    expect(issueVerdictActorLabel({ kind: 'person' })).toBe('You');
    expect(issueVerdictActorLabel({ kind: 'app', client: 'claude-code' })).toBe('Claude Code');
    expect(issueVerdictActorLabel({ kind: 'import', declaredApp: 'ChatGPT' })).toBe(
      'Imported (ChatGPT)',
    );
    expect(issueVerdictActorLabel({ kind: 'gezel', gezelId: 'bram' }, () => 'Bram')).toBe('Bram');
  });

  it('asks a duplicate to name another issue, and a reason only of not-a-bug', () => {
    expect(IssueVerdictInputSchema.safeParse({ ref: 'BW-2', kind: 'duplicate' }).success).toBe(
      false,
    );
    expect(
      IssueVerdictInputSchema.safeParse({ ref: 'BW-2', kind: 'duplicate', duplicateOf: 'BW-2' })
        .success,
    ).toBe(false);
    expect(
      IssueVerdictInputSchema.safeParse({ ref: 'BW-2', kind: 'duplicate', duplicateOf: 'BW-1' })
        .success,
    ).toBe(true);
    expect(
      IssueVerdictInputSchema.safeParse({ ref: 'BW-2', kind: 'nit', reason: 'intended' }).success,
    ).toBe(false);
  });

  it('lets an older reader drop a verdict kind it does not know and keep the issue', () => {
    const later = { kind: 'some_future_kind', by: { kind: 'person' }, at: 'x' };
    expect(IssueVerdictSummarySchema.safeParse(later).success).toBe(false);
    const issue = BoekwachterIssueSchema.parse({
      ref: 'BW-3',
      id: 'i3',
      fingerprint: 'f3',
      path: 'src/a.ts',
      severity: 'minor',
      category: 'bug',
      message: 'm',
      status: 'open',
      seen: false,
      stale: false,
      createdAt: 'x',
      lastSeenAt: 'x',
      latestVerdict: later,
    });
    expect(issue.ref).toBe('BW-3');
    expect(issue.latestVerdict).toBeUndefined();
  });
});
