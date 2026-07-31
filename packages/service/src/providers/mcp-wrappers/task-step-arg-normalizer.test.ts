import { describe, expect, it } from 'vitest';
import { TaskStepArgNormalizer } from './task-step-arg-normalizer.js';

describe('TaskStepArgNormalizer', () => {
  it('maps the legacy id field to stepId for task-note calls', async () => {
    const args = { ref: 'space-game/1', id: 'build', text: 'Acceptance criteria' };

    await expect(
      TaskStepArgNormalizer.preProcess!('write_task_note', args, {} as never),
    ).resolves.toEqual({
      kind: 'allow',
      args: {
        ref: 'space-game/1',
        stepId: 'build',
        text: 'Acceptance criteria',
      },
    });
    expect(args).toHaveProperty('id', 'build');
  });

  it('keeps an explicit stepId authoritative and removes the stale alias', async () => {
    await expect(
      TaskStepArgNormalizer.preProcess!(
        'advance_task_step',
        { ref: 'space-game/1', stepId: 'evaluate', id: 'build' },
        {} as never,
      ),
    ).resolves.toEqual({
      kind: 'allow',
      args: { ref: 'space-game/1', stepId: 'evaluate' },
    });
  });

  it('does not rewrite unrelated tools', async () => {
    await expect(
      TaskStepArgNormalizer.preProcess!(
        'get_task',
        { ref: 'space-game/1', id: 'build' },
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'allow' });
  });
});
