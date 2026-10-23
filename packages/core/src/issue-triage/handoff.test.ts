import { describe, expect, it } from 'vitest';
import type { IssueHandoffResponse } from '../schemas/api/issue-triage.js';
import { parseIssueHandoffResponses, renderIssueHandoff, verdictKind } from './handoff.js';

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
          category: 'smell',
          message: 'Long function.',
          stale: true,
        },
      ],
    },
    {
      path: 'src/load.ts',
      issues: [
        {
          ref: 'BW-9',
          severity: 'minor',
          category: 'bug',
          message: 'Unchecked null.',
          line: 3,
          stale: false,
        },
      ],
    },
  ],
  count: 3,
  remaining: 4,
  firstBatch: false,
  indexed: true,
};

const doc = renderIssueHandoff(queue, {
  projectId: 'code',
  projectName: 'Code',
  generatedAt: '2026-10-22T08:00:00.000Z',
  absolutePath: (rel) => `/repo/${rel}`,
});

/** Fill a response block the way an app would, by replacing its empty lines. */
function answer(text: string, ref: string, verdict: string, reason: string, notes: string): string {
  return text.replace(
    `<!-- gezel:response ${ref} -->\nVerdict:\nReason:\nNotes:`,
    `<!-- gezel:response ${ref} -->\nVerdict: ${verdict}\nReason: ${reason}\nNotes: ${notes}`,
  );
}

describe('the handoff document', () => {
  it('lists each issue with its absolute location and an empty response block', () => {
    expect(doc).toContain('<!-- gezel:issue-handoff project=code');
    expect(doc).toContain('### BW-4 · major · bug');
    expect(doc).toContain('`/repo/src/save.ts:12`');
    expect(doc).toContain('the file changed since the review');
    expect(doc).toContain('4 more issues are waiting');
    expect(parseIssueHandoffResponses(doc)).toEqual({
      projectId: 'code',
      verdicts: [],
      skipped: ['BW-4', 'BW-6', 'BW-9'],
    });
  });

  it('reads filled-in answers back, in the words an app uses', () => {
    let filled = answer(doc, 'BW-4', '**Fixed**', '', 'Changed `<` to `<=` at src/save.ts:12.');
    filled = answer(filled, 'BW-6', 'not a bug', 'by design', 'Kept long on purpose.');
    filled = answer(filled, 'BW-9', 'duplicate', 'BW-4', 'Same loop.');
    expect(parseIssueHandoffResponses(filled).verdicts).toEqual([
      { ref: 'BW-4', kind: 'fixed', note: 'Changed < to <= at src/save.ts:12.' },
      { ref: 'BW-6', kind: 'not_a_bug', reason: 'intended', note: 'Kept long on purpose.' },
      { ref: 'BW-9', kind: 'duplicate', duplicateOf: 'BW-4', note: 'Same loop.' },
    ]);
  });

  it('survives an app dropping the marker comments and using Windows line endings', () => {
    const filled = answer(doc, 'BW-4', "won't fix", '', 'Out of scope.')
      .replace(/<!--[^>]*-->\n?/g, '')
      .replace(/\n/g, '\r\n');
    const parsed = parseIssueHandoffResponses(filled);
    expect(parsed.verdicts).toEqual([{ ref: 'BW-4', kind: 'wont_fix', note: 'Out of scope.' }]);
    expect(parsed.projectId).toBeUndefined();
  });

  it('survives blocks reordered and issue text edited', () => {
    const filled = answer(doc, 'BW-9', 'confirmed', '', 'Null reaches line 3 from load().').replace(
      'Unchecked null.',
      'Unchecked null (the app reworded this).',
    );
    const blocks = filled.split('\n## ');
    const reordered = [blocks[0], blocks[2], blocks[1]].join('\n## ');
    expect(parseIssueHandoffResponses(reordered).verdicts).toEqual([
      { ref: 'BW-9', kind: 'confirmed', note: 'Null reaches line 3 from load().' },
    ]);
  });

  it('skips a duplicate with no other issue named, and template text left in place', () => {
    const filled = answer(doc, 'BW-4', 'duplicate', '', 'Same as another.');
    expect(parseIssueHandoffResponses(filled).verdicts).toEqual([]);
    expect(verdictKind('(fixed | not_a_bug | confirmed)')).toBeNull();
    expect(verdictKind('False positive')).toBe('not_a_bug');
    expect(verdictKind('nitpick')).toBe('nit');
  });
});
