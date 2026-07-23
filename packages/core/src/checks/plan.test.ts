import { describe, expect, it } from 'vitest';
import { planStructure } from './plan.js';

const ROSTER = ['Beatrix', 'Cas', 'Femke'];

function table(rows: string[]): string {
  return [
    '# Plan',
    '',
    '| ID | Task | Owner | Depends on | Done when |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const VALID = table([
  '| T1 | Survey the site | Beatrix | - | Survey notes reviewed by Cas |',
  '| T2 | Draft the layout | Cas | T1 | Layout approved in writing |',
  '| T3 | Order materials | Femke | T2 | All POs confirmed by suppliers |',
]);

describe('planStructure', () => {
  it('a valid plan passes and returns parsed rows', () => {
    const r = planStructure(VALID, { minRows: 3, ownerRoster: ROSTER });
    expect(r.detail).toBe('');
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[1]).toMatchObject({ id: 'T2', owner: 'Cas', dependsOn: ['T1'] });
  });

  it('accepts the optional Estimate column and none/n-a dep spellings', () => {
    const text = [
      '| ID | Task | Owner | Depends on | Done when | Estimate |',
      '| --- | --- | --- | --- | --- | --- |',
      '| T1 | Survey | Beatrix | none | Notes reviewed by Cas | 2d |',
      '| T2 | Draft | Cas | N/A | Layout approved in writing | 3d |',
      '| T3 | Order | Femke | T1, T2 | POs confirmed by suppliers | 1d |',
    ].join('\n');
    const r = planStructure(text, { ownerRoster: ROSTER });
    expect(r.ok).toBe(true);
    expect(r.rows[0]!.dependsOn).toEqual([]);
    expect(r.rows[2]!.dependsOn).toEqual(['T1', 'T2']);
    expect(r.rows[2]!.estimate).toBe('1d');
  });

  it.each(['–', '—', '−'])('treats a Unicode %s marker as no dependency', (marker) => {
    const text = VALID.replace('| Beatrix | - |', `| Beatrix | ${marker} |`);

    const r = planStructure(text, { minRows: 3, ownerRoster: ROSTER });

    expect(r.ok).toBe(true);
    expect(r.rows[0]!.dependsOn).toEqual([]);
  });

  it('no table at all names the required columns', () => {
    const r = planStructure('Just prose, no table here.');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ID \| Task \| Owner \| Depends on \| Done when/);
  });

  it('a table missing required columns names exactly the missing ones', () => {
    const r = planStructure(
      ['| ID | Task | Owner |', '| --- | --- | --- |', '| T1 | Survey | Beatrix |'].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('missing column(s): depends on, done when');
  });

  it('too few rows fails with both counts', () => {
    const r = planStructure(VALID, { minRows: 8 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/3 row\(s\) — at least 8 required/);
  });

  it('duplicate row ids are named', () => {
    const r = planStructure(
      table([
        '| T1 | Survey | Beatrix | - | Notes reviewed by Cas |',
        '| T1 | Draft | Cas | - | Layout approved in writing |',
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('duplicate plan row id "T1"');
  });

  it('an off-roster owner fails naming the row, the owner, and the roster', () => {
    const r = planStructure(VALID.replace('| Femke |', '| Ola |'), { ownerRoster: ROSTER });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('row T3');
    expect(r.detail).toContain('"Ola"');
    expect(r.detail).toContain('Beatrix');
  });

  it('roster matching is case-insensitive', () => {
    const r = planStructure(VALID.replace('| Cas |', '| cas |'), { ownerRoster: ROSTER });
    expect(r.ok).toBe(true);
  });

  it('an empty Owner cell fails with the row named', () => {
    const r = planStructure(VALID.replace('| Cas |', '|  |'));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/row T2: the Owner cell is empty/);
  });

  it('an unknown dependency names the row and the phantom id', () => {
    const r = planStructure(
      VALID.replace('| T2 |', '| T9 |').replace('| T1 | Survey', '| T1 | Survey'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/references T2, which is not a row ID|row T3/);
  });

  it('a self-dependency is rejected', () => {
    const r = planStructure(
      table(['| T1 | Survey the site | Beatrix | T1 | Survey notes reviewed |']),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('row T1 depends on itself');
  });

  it('a forward (later-row) dependency fails by default and passes when earlier-only is off', () => {
    const forward = table([
      '| T1 | Survey the site | Beatrix | T2 | Survey notes reviewed by Cas |',
      '| T2 | Draft the layout | Cas | - | Layout approved in writing |',
    ]);
    const strict = planStructure(forward);
    expect(strict.ok).toBe(false);
    expect(strict.detail).toMatch(/T1: "Depends on" references T2, which is a LATER row/);
    expect(planStructure(forward, { requireEarlierOnly: false }).ok).toBe(true);
  });

  it('a dependency cycle is detected when earlier-only is off', () => {
    const cyclic = table([
      '| T1 | Survey the site | Beatrix | T2 | Survey notes reviewed by Cas |',
      '| T2 | Draft the layout | Cas | T1 | Layout approved in writing |',
    ]);
    const r = planStructure(cyclic, { requireEarlierOnly: false });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/dependency cycle: /);
    expect(r.cycleIds.length).toBeGreaterThanOrEqual(2);
  });

  it('a vague Done-when fails quoting the cell', () => {
    const r = planStructure(VALID.replace('Layout approved in writing', 'done'));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/row T2: "Done when" is "done" — too vague/);
    expect(r.weakDoneStates).toEqual(['T2']);
  });
});
