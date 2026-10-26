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

  it('recognizes plain filenames and reading/opening instructions without swallowing outputs', () => {
    expect(
      paths(
        'Start by reading src/domain.ts, src/repository.ts, and tsconfig.json. ' +
          'Update the sources and write src/convert.ts and CHANGELOG.md.',
      ),
    ).toEqual(['src/domain.ts', 'src/repository.ts', 'tsconfig.json']);
    expect(paths('Begin by opening data/raw.csv before writing out/result.json.')).toEqual([
      'data/raw.csv',
    ]);
    expect(paths('Read deploy.log,hotfix.diff; then write summary.md.')).toEqual([
      'deploy.log',
      'hotfix.diff',
    ]);
  });

  it('keeps mixed quoted/plain inputs in order and ignores URLs and property names', () => {
    expect(paths('Read inputs/a.json, `inputs/b.json`, and inputs/a.json.')).toEqual([
      'inputs/a.json',
      'inputs/b.json',
    ]);
    expect(paths('Read https://example.org/data.json and record.name.')).toEqual([]);
    expect(paths('Write summary.md without reading notes.md.')).toEqual([]);
  });

  it('does not interpret words inside file paths as read or write instructions', () => {
    expect(
      paths('Read src/edit.ts, `src/update.ts`, and build/config.json; write result.md.'),
    ).toEqual(['src/edit.ts', 'src/update.ts', 'build/config.json']);
    expect(paths('Write src/read.md and output/result.json.')).toEqual([]);
    expect(paths('Create `open.md` and `summary.md`.')).toEqual([]);
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
