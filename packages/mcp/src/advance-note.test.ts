import { describe, expect, it } from 'vitest';
import { advanceHandoffNote } from './advance-note.js';

describe('advanceHandoffNote', () => {
  it('reports a started handoff when the task stayed active with an assignee', () => {
    const note = advanceHandoffNote({ status: 'active', assigneeId: 'esra' });
    expect(note).toContain('Started esra on it');
  });

  it('reports completion on a terminal step', () => {
    const note = advanceHandoffNote({ status: 'complete', assigneeId: undefined });
    expect(note).toContain('complete');
  });

  it('reports no handoff when nobody is assigned', () => {
    const note = advanceHandoffNote({ status: 'active', assigneeId: undefined });
    expect(note).toContain('no handoff was started');
  });

  it('never claims a handoff when the runtime paused the task at activation', () => {
    // gezel/10: the new step's deliverable targeted a workspace file on a
    // writes-off project, so the runtime paused instead of dispatching —
    // but the step still resolved a suggestedGezelId, and the old text
    // said "Started esra on it".
    const note = advanceHandoffNote({ status: 'paused', assigneeId: 'esra' });
    expect(note).not.toContain('Started esra');
    expect(note).toContain('PAUSED');
    expect(note).toContain('NO handoff was started');
    expect(note).toContain('read_task_notes');
  });
});
