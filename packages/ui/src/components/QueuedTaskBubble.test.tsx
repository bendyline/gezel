import type { GezelSummary, Task, TaskWaitState } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueuedTaskBubble, queuedTaskKindLabel, queuedTaskReasonCopy } from './QueuedTaskBubble.js';

vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({ useRoleBasedNameOnlyMode: () => false }));

const TASK = {
  num: 6,
  ref: 'gezel/6',
  projectId: 'gezel',
  title: 'Pull Request Review',
  status: 'active',
} as unknown as Task;

const KORAY: GezelSummary = { id: 'koray', name: 'Koray', role: 'Reviewer' } as GezelSummary;

function waitState(overrides: Partial<TaskWaitState> = {}): TaskWaitState {
  return {
    ref: 'gezel/6',
    reason: 'queued',
    gezelId: 'koray',
    since: new Date(Date.now() - 4 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('QueuedTaskBubble', () => {
  it('names the task, its number, and who it is waiting on', () => {
    render(<QueuedTaskBubble task={TASK} wait={waitState()} gezel={KORAY} />);
    expect(screen.getByText('Pull Request Review')).toBeInTheDocument();
    expect(screen.getByText('#6')).toBeInTheDocument();
    expect(screen.getByText('In the queue')).toBeInTheDocument();
    expect(screen.getByText(/starts as soon as Koray is free/i)).toBeInTheDocument();
  });

  it('opens the task from the ref chip', () => {
    const onTaskReference = vi.fn();
    render(
      <QueuedTaskBubble
        task={TASK}
        wait={waitState()}
        gezel={KORAY}
        onTaskReference={onTaskReference}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Task gezel\/6/ }));
    expect(onTaskReference).toHaveBeenCalledWith('gezel/6');
  });

  it('does not promise a start time for work that is deliberately parked', () => {
    render(
      <QueuedTaskBubble task={TASK} wait={waitState({ reason: 'night-shift' })} gezel={KORAY} />,
    );
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText(/Night Shift/)).toBeInTheDocument();
  });

  it('reads as on hold when the user turned engagement off', () => {
    render(
      <QueuedTaskBubble task={TASK} wait={waitState({ reason: 'engagement-off' })} gezel={KORAY} />,
    );
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.getByText(/AI engagement is off/i)).toBeInTheDocument();
  });

  it('falls back to a neutral assignee when the roster has not loaded', () => {
    render(<QueuedTaskBubble task={TASK} wait={waitState()} />);
    expect(screen.getByText(/the assigned gezel is free/i)).toBeInTheDocument();
    expect(screen.queryByTestId('gezel-icon')).toBeNull();
  });

  it('labels every wait reason without falling through to a bare default', () => {
    const reasons: TaskWaitState['reason'][] = [
      'dispatching',
      'provider-busy',
      'night-shift',
      'night-quota',
      'engagement-off',
      'engagement-paused',
      'queued',
    ];
    for (const reason of reasons) {
      expect(queuedTaskKindLabel(reason)).not.toBe('');
      expect(queuedTaskReasonCopy(reason, 'Koray')).toMatch(/\S/);
    }
  });
});
