import { describe, expect, it } from 'vitest';
import { gateHandoffNoteText, renderGateHandoffBlock, stampGateHandoff } from './gate-handoff.js';

const handoff = { message: 'Three items still open', params: { remaining: 3, file: 'a.md' } };

describe('gate handoff', () => {
  it('stamps only the fields that are present', () => {
    expect(stampGateHandoff('build', 'review', { message: 'go' }, 't')).toEqual({
      fromStepId: 'build',
      toStepId: 'review',
      message: 'go',
      at: 't',
    });
    expect(stampGateHandoff('build', undefined, handoff, 't')).not.toHaveProperty('toStepId');
  });
  it('writes the note with one line per parameter', () => {
    expect(gateHandoffNoteText('Build', handoff)).toBe(
      '# Handoff from gate on "Build"\n\nThree items still open\n\n- remaining: 3\n- file: a.md',
    );
  });
  it('renders the block only for the step the handoff was addressed to', () => {
    const task = { lastGateHandoff: stampGateHandoff('build', 'review', handoff, 't') };
    expect(renderGateHandoffBlock(task, 'review')).toContain('Three items still open');
    expect(renderGateHandoffBlock(task, 'build')).toBe('');
    expect(renderGateHandoffBlock({}, 'review')).toBe('');
  });
});
