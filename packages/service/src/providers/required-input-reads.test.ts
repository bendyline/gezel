import { describe, expect, it } from 'vitest';
import { promptReadInputs, unreadRequiredInputs } from './required-input-reads.js';

const paths = (prompt: string) => promptReadInputs(prompt).map((input) => input.path);

describe('promptReadInputs', () => {
  it('collects every file a read instruction names, up to the write verb', () => {
    expect(
      paths(
        'Read `meeting/transcript.md`, `meeting/roster.md`, and the explicitly stale ' +
          '`meeting/old-agenda.md`. Create two workspace-root deliverables: ' +
          '`meeting-brief.md` and `action-items.csv`. Write both files now.',
      ),
    ).toEqual(['meeting/transcript.md', 'meeting/roster.md', 'meeting/old-agenda.md']);
  });

  it('never treats the write target in the same sentence as an input', () => {
    expect(paths('Read `data/raw.csv` and write `out/customers.json` now.')).toEqual([
      'data/raw.csv',
    ]);
  });

  it('ignores prompts that only ask for a write, and negated reads', () => {
    expect(paths('Write `index.html` now.')).toEqual([]);
    expect(paths("Don't read `notes.md`; write `summary.md` now.")).toEqual([]);
  });

  it('is satisfied by the reads the send has made', () => {
    const required = promptReadInputs('Read `a.md` and `b.md`, then write `c.md` now.');
    expect(
      unreadRequiredInputs(required, [{ path: 'a.md', artifact: false }]).map((i) => i.path),
    ).toEqual(['b.md']);
  });
});
