import type { Question, Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { OWNER_STEP_APPROVE, answerOwnerStep, ownerStepQuestion } from './owner-step.js';

const draft = { id: 'draft', name: 'Draft posts' } as TaskCraftbookStep;
const review = {
  id: 'owner-review',
  name: 'Owner Review',
  assignee: { kind: 'user' },
} as TaskCraftbookStep;

const task = (over: Partial<Task> = {}): Task =>
  ({
    projectId: 'default',
    num: 2,
    ref: 'default/2',
    title: 'Weekly posts',
    status: 'active',
    activeStepId: 'owner-review',
    assignee: { kind: 'gezel', gezelId: 'kylian' },
    craftbook: { steps: [draft, review] },
    ...over,
  }) as Task;

function fakeTasks(current: Task | null) {
  return {
    get: vi.fn(async () => current),
    appendNote: vi.fn(async () => ({}) as never),
    completeStepChecked: vi.fn(async () => ({ status: 'advanced' }) as never),
  };
}

function answered(q: Question, answer: Question['answer']): Question {
  return { ...q, answer };
}

describe('ownerStepQuestion', () => {
  it('asks the owner and says where a change request goes', () => {
    const q = ownerStepQuestion({
      task: task(),
      step: review,
      returnTo: draft,
      askerGezelId: 'kylian',
    });
    expect(q.prompt).toContain('**Owner Review** on "Weekly posts" is waiting for you');
    expect(q.prompt).toContain('goes back to "Draft posts"');
    expect(q.choices).toEqual([OWNER_STEP_APPROVE]);
    expect(q.allowWriteIn).toBe(true);
    expect(q.intent).toEqual({
      kind: 'step-awaits-owner',
      taskRef: 'default/2',
      stepId: 'owner-review',
      returnToStepId: 'draft',
    });
    expect(q.documentPath).toBeUndefined();
  });

  // The normalized owner step no longer runs the book's review procedure, so
  // the card is the only thing that puts the work in front of the owner.
  it('lists the work under review, the gated deliverable first', () => {
    const gatedDraft = {
      ...draft,
      advanceWhen: { file: 'posts/_drafting/post.md', minBytes: 200 },
    } as TaskCraftbookStep;
    const q = ownerStepQuestion({
      task: task({ craftbook: { steps: [gatedDraft, review] } as Task['craftbook'] }),
      step: review,
      returnTo: gatedDraft,
      askerGezelId: 'kylian',
      outputs: [
        { kind: 'workspace', path: 'posts/_drafting/variants/instagram.md' },
        { kind: 'artifact', path: 'tasks/2/deck.pptx' },
        { kind: 'artifact', path: 'tasks/2/notes.md' },
        { kind: 'workspace', path: 'posts/_drafting/post.md' },
      ],
    });
    expect(q.prompt.split('\n')).toEqual([
      '**Owner Review** on "Weekly posts" is waiting for you.',
      '',
      'To review:',
      '',
      '- `posts/_drafting/post.md` (in the project folder)',
      '- `posts/_drafting/variants/instagram.md` (in the project folder)',
      '- `tasks/2/deck.pptx`',
      '- `tasks/2/notes.md`',
      '',
      'Choose Approve to continue, or write what should change and it goes back to "Draft posts".',
    ]);
    // A deck would render as bytes; the first readable artifact is previewed.
    expect(q.documentPath).toBe('tasks/2/notes.md');
  });

  // The owner approved a quote whose subtotal was $100 too high; nothing had
  // looked at the numbers.
  it('puts what the figure checks found in front of the owner before they approve', () => {
    const q = ownerStepQuestion({
      task: task(),
      step: review,
      returnTo: draft,
      askerGezelId: 'kylian',
      outputs: [{ kind: 'artifact', path: 'tasks/2/quote.md' }],
      figures: {
        problems: ['The subtotal says $297.00, but the items above it add up to $197.00.'],
        checked: ['sums'],
      },
    });
    expect(q.prompt).toContain(
      'Before you approve, check:\n\n- The subtotal says $297.00, but the items above it add up to $197.00.',
    );
    expect(q.prompt.trim().endsWith('goes back to "Draft posts".')).toBe(true);
  });
});

describe('answerOwnerStep', () => {
  const card = ownerStepQuestion({
    task: task(),
    step: review,
    returnTo: draft,
    askerGezelId: 'kylian',
  });

  it('completes the step as the owner on Approve', async () => {
    const tasks = fakeTasks(task());
    await expect(
      answerOwnerStep(tasks, answered(card, { selectedChoices: [0], answeredAt: 'x' } as never)),
    ).resolves.toBe('approved');
    expect(tasks.completeStepChecked).toHaveBeenCalledWith(
      'default',
      2,
      'owner-review',
      undefined,
      { force: true, cause: 'user' },
    );
  });

  it('sends the work back with the owner note as that step note', async () => {
    const tasks = fakeTasks(task());
    await expect(
      answerOwnerStep(
        tasks,
        answered(card, { writeIn: 'Use this year in the dates.', answeredAt: 'x' } as never),
      ),
    ).resolves.toBe('sent-back');
    expect(tasks.appendNote).toHaveBeenCalledWith('default', 2, {
      text: 'The owner asked for changes: Use this year in the dates.',
      author: { kind: 'user' },
      stepId: 'draft',
    });
    expect(tasks.completeStepChecked).toHaveBeenCalledWith('default', 2, 'owner-review', 'draft', {
      force: true,
      cause: 'user',
    });
  });

  it('changes nothing once the step has moved on', async () => {
    const tasks = fakeTasks(task({ activeStepId: 'draft' }));
    await expect(
      answerOwnerStep(tasks, answered(card, { selectedChoices: [0], answeredAt: 'x' } as never)),
    ).resolves.toBe('stale');
    expect(tasks.completeStepChecked).not.toHaveBeenCalled();
  });

  it('does nothing for a skipped card', async () => {
    const tasks = fakeTasks(task());
    await expect(
      answerOwnerStep(tasks, answered(card, { silentSkip: true, answeredAt: 'x' } as never)),
    ).resolves.toBe('skipped');
    expect(tasks.completeStepChecked).not.toHaveBeenCalled();
  });
});
