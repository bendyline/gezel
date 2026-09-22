import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { isGatedStep, renderTaskContextBlock, renderTaskOutline } from './prompt-context.js';

const task = {
  ref: 'default/3',
  num: 3,
  projectId: 'default',
  title: 'Ship the launch page',
  description: 'Build and review the page.',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'ada' },
  activeStepId: 'review',
  executionMode: 'generalist',
  craftbook: {
    id: 'launch',
    description: 'A launch page that converts.',
    steps: [
      { id: 'build', name: 'Build', prompt: 'Write the page.', completedAt: 't', next: 'review' },
      {
        id: 'review',
        name: 'Review',
        prompt: 'Check every link.',
        attemptCount: 2,
        gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'index.html', bytes: 1 }] },
        next: 'build',
      },
    ],
  },
  lastGateHandoff: {
    fromStepId: 'build',
    toStepId: 'review',
    message: 'Two links are dead',
    at: 't',
  },
} as unknown as Task;
const step = task.craftbook.steps[1]!;

describe('renderTaskContextBlock', () => {
  it('renders the task, the outline, the procedure, the handoff and the gate', () => {
    const block = renderTaskContextBlock({ task, step });
    expect(block).toContain('### Current task: default/3 — "Ship the launch page"');
    expect(block).toContain('### Task outline');
    expect(block).toContain('1. Build (done)');
    expect(block).toContain('2. Review (active) (gated)');
    expect(block).toContain('#### Step procedure\n\nCheck every link.');
    expect(block).toContain('#### Handoff from the completion gate\n\nTwo links are dead');
    expect(block).toContain('#### Phase gate');
    expect(block).toContain('attempt 2');
    expect(block).toContain('Task tools wired this turn');
  });

  it('narrows the guidance to the tools this turn wired', () => {
    const block = renderTaskContextBlock(
      { task, step },
      { availableToolNames: new Set(['read_task_notes']) },
    );
    expect(block).toContain('Task tools wired this turn: `read_task_notes`.');
    expect(block).not.toContain('Task artifact folder');
    expect(block).toContain('finish and pass them before the next step is revealed');
  });

  it('is deterministic and carries no timestamp', () => {
    expect(renderTaskContextBlock({ task, step })).toBe(renderTaskContextBlock({ task, step }));
    expect(renderTaskOutline(task, step, { advanceWired: true })).toContain('`advance_task_step`');
    expect(isGatedStep(step, task.craftbook.steps)).toBe(true);
    expect(isGatedStep(task.craftbook.steps[0]!, task.craftbook.steps)).toBe(false);
  });
});
