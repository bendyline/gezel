import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { entryStepStart } from './entry-step-start.js';

function task(over: {
  assignee?: Task['assignee'];
  step?: Record<string, unknown>;
  status?: string;
}) {
  const now = '2026-10-31T00:00:00Z';
  return {
    projectId: 'supplier-intake',
    num: 4,
    ref: 'supplier-intake/4',
    title: 'Process Q2 suppliers',
    status: over.status ?? 'active',
    assignee: over.assignee ?? { kind: 'user' },
    activeStepId: 'analyze',
    craftbook: {
      id: 'supplier-intake-process',
      name: 'Supplier Intake Process',
      entryStepId: 'analyze',
      steps: [
        { id: 'analyze', name: 'Analyze supplier data', createdAt: now, ...over.step },
        { id: 'report', name: 'Write the report', createdAt: now },
      ],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'gezel', gezelId: 'kathleen' },
  } as unknown as Task;
}

describe('entryStepStart', () => {
  it('says nobody will start a first step that no gezel owns, and how to fix it', () => {
    // gemma4-12b's own recipe named no roles; both of its tasks sat idle
    // after being told they were dispatched (2026-10-31).
    const start = entryStepStart(task({}));
    expect(start.underway).toBe(false);
    expect(start.text).toContain(
      'Nobody was assigned to start its first step "Analyze supplier data"',
    );
    expect(start.text).toContain('assign_task({ ref: "supplier-intake/4"');
    expect(start.text).toContain('Do not invoke the recipe again');
    expect(start.text).not.toContain('dispatched');
  });

  it('keeps the dispatched line when a role or the task names a gezel', () => {
    for (const t of [
      task({ step: { suggestedGezelId: 'katarzyna', suggestedRole: 'developer' } }),
      task({ assignee: { kind: 'gezel', gezelId: 'kathleen' } }),
    ]) {
      expect(entryStepStart(t)).toEqual({
        text: 'Active step analyze was dispatched to the recipe-selected specialist.',
        underway: true,
      });
    }
  });

  it('says the person’s own first step waits for them', () => {
    const start = entryStepStart(task({ step: { assignee: { kind: 'user' } } }));
    expect(start).toEqual({
      text: 'Its first step "Analyze supplier data" is the person\'s own step, so it waits for them.',
      underway: false,
    });
  });
});
