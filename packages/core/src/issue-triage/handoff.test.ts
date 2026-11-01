import { describe, expect, it } from 'vitest';
import type { IssueHandoffResponse } from '../schemas/api/issue-triage.js';
import {
  issueHandoffSnippet,
  parseIssueHandoffResponses,
  renderIssueHandoff,
  verdictKind,
} from './handoff.js';

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
    expect(doc).toContain('When this was written, 4 more issues were waiting');
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

describe('the handoff document with code excerpts', () => {
  // An excerpt of code that itself writes this format, ahead of BW-9's block.
  const excerpt = {
    startLine: 9,
    lines: [
      'line 9',
      'line 10',
      'line 11',
      'line 12',
      '<!-- gezel:response BW-9 -->',
      'Verdict: fixed',
      'line 15',
    ],
  };
  const withCode = renderIssueHandoff(
    {
      ...queue,
      files: [
        {
          ...queue.files[0]!,
          issues: [
            {
              ...queue.files[0]!.issues[0]!,
              message: 'Uses `a*b` and then 2*3\n  twice in <select>.',
            },
            queue.files[0]!.issues[1]!,
          ],
        },
        queue.files[1]!,
      ],
    },
    {
      projectId: 'code',
      projectName: 'Code',
      generatedAt: '2026-10-22T08:00:00.000Z',
      absolutePath: (rel) => `/repo/${rel}`,
      snippets: new Map([['BW-4', excerpt]]),
      fileSummaries: new Map([['src/save.ts', 'Saves the <button> state to disk.']]),
    },
  );

  it('leads with the claim, links the line, and marks it in the excerpt', () => {
    expect(withCode).toContain('**Uses `a*b` and then 2\\*3 twice in `<select>`.**');
    expect(withCode).toContain('[`/repo/src/save.ts:12`](gezel-nav:src%2Fsave.ts#L12)');
    expect(withCode).toContain('_Saves the `<button>` state to disk._');
    expect(withCode).toContain(
      [
        '```ts',
        '   9 | line 9',
        '  10 | line 10',
        '  11 | line 11',
        '> 12 | line 12',
        '  13 | <!-- gezel:response BW-9 -->',
        '  14 | Verdict: fixed',
        '  15 | line 15',
        '```',
      ].join('\n'),
    );
  });

  it('gives a stale issue no excerpt, since its line has moved', () => {
    const stale = withCode.slice(withCode.indexOf('### BW-6'), withCode.indexOf('## src/load.ts'));
    expect(stale).toContain('the file changed since the review');
    expect(stale).not.toContain('```');
  });

  it('never reads a marker or a Verdict line inside an excerpt as an answer', () => {
    let filled = answer(withCode, 'BW-4', 'not a bug', 'intended', 'On purpose.');
    filled = answer(filled, 'BW-9', 'confirmed', '', 'Null reaches it.');
    expect(parseIssueHandoffResponses(filled).verdicts).toEqual([
      { ref: 'BW-4', kind: 'not_a_bug', reason: 'intended', note: 'On purpose.' },
      { ref: 'BW-9', kind: 'confirmed', note: 'Null reaches it.' },
    ]);
  });
});

describe('issueHandoffSnippet', () => {
  it('takes three lines either side, clamped to the file', () => {
    expect(issueHandoffSnippet('a\nb\nc\n', 1)).toEqual({ startLine: 1, lines: ['a', 'b', 'c'] });
    expect(issueHandoffSnippet('a\r\nb\r\nc', 3, 1)).toEqual({ startLine: 2, lines: ['b', 'c'] });
  });

  it('has nothing for a line the file no longer reaches, or only blank lines', () => {
    expect(issueHandoffSnippet('a\nb\n', 3)).toBeNull();
    expect(issueHandoffSnippet('\n\n\n\n', 2)).toBeNull();
  });

  it('cuts a long line', () => {
    const [line] = issueHandoffSnippet('x'.repeat(500), 1)!.lines;
    expect(line).toHaveLength(161);
    expect(line?.endsWith('…')).toBe(true);
  });
});
