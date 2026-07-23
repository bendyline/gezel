import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { planGuardrails, renderPlanDocument, summarizePlanDocument } from './plan-document.js';

const now = '2026-06-22T00:00:00Z';

function draftTask(overrides: Partial<Task> = {}): Task {
  return {
    projectId: 'proj',
    num: 7,
    ref: 'proj/7',
    title: 'Snake game',
    description: 'x'.repeat(140),
    outcomes: [
      { id: 'o1', text: 'index.html with a playable snake game' },
      { id: 'o2', text: 'a game-over screen' },
      { id: 'o3', text: 'a live score counter' },
    ],
    status: 'draft',
    assignee: { kind: 'user' },
    craftbook: {
      id: 'plan-task',
      name: 'Snake',
      steps: [
        {
          id: 'build',
          name: 'Build the game',
          createdAt: now,
          advanceWhen: { file: 'index.html' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 1500 }],
            scripts: [{ name: 'checkHtmlGame', scope: 'standard', inputs: { file: 'index.html' } }],
            onReject: 'build',
            maxAttempts: 4,
          },
          next: 'verify',
        },
        {
          id: 'verify',
          name: 'Verify outcomes',
          createdAt: now,
          prompt: 'verify_outcome each then set_task_status complete',
          terminal: true,
        },
      ],
      entryStepId: 'build',
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
    ...overrides,
  } as Task;
}

describe('plan-document', () => {
  it('renders a draft task as a readable plan document', () => {
    const md = renderPlanDocument(draftTask());
    expect(md).toContain('# Plan: Snake game');
    expect(md).toContain('## Outcomes');
    expect(md).toContain('index.html with a playable snake game');
    expect(md).toContain('`index.html`');
    expect(md).toContain('✅ Ready to run.');
  });

  it('summarizes steps, deliverables, and the verification step', () => {
    const s = summarizePlanDocument(draftTask());
    expect(s.buildStepCount).toBe(1);
    expect(s.gatedBuildStepCount).toBe(1);
    expect(s.hasVerification).toBe(true);
    expect(s.outcomes).toHaveLength(3);
    expect(s.steps.find((x) => x.id === 'build')?.deliverable).toBe('index.html');
  });

  it('flags guardrails for a thin plan (no about, no outcomes)', () => {
    const guards = planGuardrails(
      summarizePlanDocument(draftTask({ outcomes: [], description: 'short' })),
    );
    expect(guards.join(' ')).toMatch(/about/);
    expect(guards.join(' ')).toMatch(/3 outcomes/);
  });

  it('flags a missing verification step', () => {
    const t = draftTask();
    t.craftbook.steps = t.craftbook.steps.filter((x) => x.id !== 'verify');
    const guards = planGuardrails(summarizePlanDocument(t));
    expect(guards.join(' ')).toMatch(/verification/);
  });

  it('marks a verified outcome as checked with its evidence', () => {
    const t = draftTask();
    t.outcomes![0] = { ...t.outcomes![0]!, met: true, evidence: 'index.html line 40' };
    const md = renderPlanDocument(t);
    expect(md).toContain('[x] index.html with a playable snake game');
    expect(md).toContain('index.html line 40');
  });
});
