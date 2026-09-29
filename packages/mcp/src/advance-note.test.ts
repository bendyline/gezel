import { describe, expect, it } from 'vitest';
import { advanceHandoffNote, advanceStatusLine } from './advance-note.js';

describe('advanceStatusLine', () => {
  const base = { completedName: 'Scope the Week', taskTitle: 'Weekly posts' };

  it('says what finished and what is next, in words a person reads', () => {
    expect(advanceStatusLine({ ...base, nextName: 'Draft posts', status: 'active' })).toBe(
      'Finished "Scope the Week". Next: "Draft posts".',
    );
  });

  it('closes the task in plain words, without ids or step bookkeeping', () => {
    const line = advanceStatusLine({ ...base, nextName: undefined, status: 'complete' });
    expect(line).toBe('Finished "Scope the Week". "Weekly posts" is complete.');
    expect(line).not.toMatch(/default\/|Active step|terminal step/);
  });

  it('hands an owner step to the person', () => {
    expect(
      advanceStatusLine({ ...base, nextName: 'Owner Review', status: 'active', ownerStep: true }),
    ).toBe('Finished "Scope the Week". Next: "Owner Review", which is waiting for your review.');
  });

  it('does not claim a next step when the task paused', () => {
    expect(advanceStatusLine({ ...base, nextName: 'Draft posts', status: 'paused' })).toBe(
      'Finished "Scope the Week", but the task paused before the next step.',
    );
  });
});

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

  it('hands an owner step to the user and tells the gezel to stop', () => {
    const note = advanceHandoffNote({ status: 'active', assigneeId: 'omroeper', ownerStep: true });
    expect(note).not.toContain('Started');
    expect(note).toContain("user's own review");
    expect(note).toContain('Do not work on or advance it');
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
