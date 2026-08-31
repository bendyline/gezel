import type { Question } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

// `useEffectiveTheme` (reached via the markdown renderer) subscribes to
// `window.matchMedia`, which jsdom doesn't implement — same stub the
// DocumentsView / DocumentDetail specs use.
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const REPORT = [
  '# Night Shift Oversight Report',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Line ${i}`),
].join('\n');

vi.mock('../api.js', () => ({
  api: createMockApi({
    getTaskByRef: vi.fn().mockResolvedValue({
      ref: 'learning/3',
      title: 'historical-battle-report',
      status: 'paused',
    }),
    readDocument: vi.fn().mockResolvedValue({ content: REPORT, kind: 'artifact' }),
  }),
}));

const { PendingQuestionCard } = await import('./PendingQuestionCard.js');
const { api } = await import('../api.js');

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'learning',
    gezelId: 'yusuf',
    sessionId: 'sess-1',
    prompt: 'Which approach?',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** The card as the service files it when a background task pauses for help. */
function taskPaused(): Question {
  return question({
    gezelId: 'yusuf',
    sessionId: '',
    prompt: 'Task learning/3 paused for help: fail-fast budget.',
    choices: ['Dismiss'],
    allowWriteIn: false,
    multiSelect: false,
    taskRef: 'learning/3',
    intent: { kind: 'task-paused', taskRef: 'learning/3', reason: 'budget_exhausted' },
  });
}

describe('PendingQuestionCard navigation', () => {
  it('hands the question to the host so it can focus the right thread', () => {
    const onOpenInChat = vi.fn();
    render(<PendingQuestionCard question={question()} onOpenInChat={onOpenInChat} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));

    expect(onOpenInChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
  });

  it('renders a craftbook MCP install request and submits approval', async () => {
    render(
      <PendingQuestionCard
        question={question({
          prompt: 'The powerpoint-deck craftbook needs Example MCP. Install it?',
          choices: ['Install', 'Not now'],
          allowWriteIn: false,
          intent: {
            kind: 'toolset-install-approval',
            toolsetId: 'example-mcp',
            sourceId: 'bundled',
            version: '1.2.3',
            targetProjectId: 'learning',
            craftbookId: 'powerpoint-deck',
          },
        })}
      />,
    );

    expect(screen.getByText(/powerpoint-deck craftbook needs Example MCP/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => {
      expect(api.answerQuestion).toHaveBeenCalledWith('q1', { selectedChoices: [0] });
    });
  });

  // A task-paused card is service-synthesized with no session behind it, so
  // the button would navigate nowhere. Its route out is "Open task".
  it('hides "Open in chat" when the question has no thread', async () => {
    render(<PendingQuestionCard question={taskPaused()} onOpenInChat={vi.fn()} />);

    await screen.findByRole('button', { name: 'Open task' });
    expect(screen.queryByRole('button', { name: 'Open in chat' })).toBeNull();
  });

  // An attached document is lifted out of the card's context strip into
  // its own column — once, never twice — and reads as a full portrait
  // page, so the ten-line teaser's expand toggle has nothing to do.
  it('lifts an attached document into its own panel', async () => {
    const { container } = render(
      <PendingQuestionCard
        question={question({ documentPath: 'artifacts/night-shift-report.md' })}
      />,
    );

    const heading = await screen.findByText('Night Shift Oversight Report');
    expect(heading.closest('.pending-question-document-panel')).not.toBeNull();
    expect(container.querySelectorAll('.pending-question-document')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show full document' })).toBeNull();
  });

  // The collapsed one-line "Answered" form has nothing to sit beside.
  it('keeps an answered card single-column', async () => {
    const { container } = render(
      <PendingQuestionCard
        question={question({
          documentPath: 'artifacts/night-shift-report.md',
          answer: { selectedChoices: [0], at: '2026-01-01T00:01:00.000Z' },
        })}
      />,
    );

    expect(container.querySelector('.pending-question-splitwrap')).toBeNull();
  });

  // Dismiss only collapses the card — the task stays paused. The retry
  // button is the one control that gets the work moving again, so it must
  // restart the task BEFORE the card is answered away.
  it('restarts a paused task and then clears its card', async () => {
    vi.mocked(api.retryTask).mockResolvedValue({
      task: { ref: 'learning/3', status: 'active' },
      dispatched: true,
      gezelId: 'yusuf',
      assigneeName: 'Yusuf',
    } as never);
    const onAnswered = vi.fn();
    render(<PendingQuestionCard question={taskPaused()} onAnswered={onAnswered} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(api.retryTask).toHaveBeenCalledWith('learning', 3);
    });
    await waitFor(() => {
      expect(api.answerQuestion).toHaveBeenCalledWith('q1', { selectedChoices: [0] });
    });
    expect(onAnswered).toHaveBeenCalled();
  });

  // The task un-paused but nobody was put back to work: collapsing the card
  // would hide the one thing the user still has to fix.
  it('keeps the card open and says why when nothing could be re-driven', async () => {
    vi.mocked(api.retryTask).mockResolvedValue({
      task: { ref: 'learning/3', status: 'active' },
      dispatched: false,
      reason: 'project-inactive',
    } as never);
    render(<PendingQuestionCard question={taskPaused()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await screen.findByText(/isn't taking background work/);
    expect(api.answerQuestion).not.toHaveBeenCalled();
  });

  it('opens the attached task as a tab', async () => {
    const opened = vi.fn();
    window.addEventListener('gezel:open-tab', opened);
    render(<PendingQuestionCard question={taskPaused()} onOpenInChat={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }));
    window.removeEventListener('gezel:open-tab', opened);

    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      kind: 'task',
      ref: 'learning/3',
    });
  });

  // The gezel is blocked on the question, so "stop working on this" has to
  // be answerable from here — otherwise the user answers something they
  // don't mean just to get to the Tasks view and pause it there.
  it('pauses the attached task and then clears the card', async () => {
    vi.mocked(api.setTaskStatus).mockResolvedValue({
      ref: 'learning/3',
      status: 'paused',
    } as never);
    const onAnswered = vi.fn();
    render(
      <PendingQuestionCard
        question={question({ taskRef: 'learning/3' })}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Pause task' }));

    await waitFor(() => {
      expect(api.setTaskStatus).toHaveBeenCalledWith('learning', 3, 'paused');
    });
    // Silent-skip, not `declined` — pausing is not "proceed with defaults".
    await waitFor(() => {
      expect(api.answerQuestion).toHaveBeenCalledWith('q1', { silentSkip: true });
    });
    expect(onAnswered).toHaveBeenCalled();
  });

  it('cancels the attached task from the card', async () => {
    vi.mocked(api.setTaskStatus).mockResolvedValue({
      ref: 'learning/3',
      status: 'canceled',
    } as never);
    render(<PendingQuestionCard question={question({ taskRef: 'learning/3' })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));

    await waitFor(() => {
      expect(api.setTaskStatus).toHaveBeenCalledWith('learning', 3, 'canceled');
    });
  });

  // A failed steer must not collapse the card onto a task that never moved.
  it('keeps the card open when the task could not be paused', async () => {
    vi.mocked(api.setTaskStatus).mockRejectedValue(new Error('task is complete'));
    render(<PendingQuestionCard question={question({ taskRef: 'learning/3' })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Pause task' }));

    await screen.findByText('task is complete');
    expect(api.answerQuestion).not.toHaveBeenCalled();
  });

  it('offers no task controls on a question with no task', () => {
    render(<PendingQuestionCard question={question()} />);

    expect(screen.queryByRole('button', { name: 'Pause task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel task' })).toBeNull();
  });

  it('no longer offers "Just do whatever"', () => {
    render(<PendingQuestionCard question={question()} />);

    expect(screen.queryByRole('button', { name: 'Just do whatever' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });
});
