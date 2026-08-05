import type { Question } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

// `useEffectiveTheme` (reached via the markdown renderer) subscribes to
// `window.matchMedia`, which jsdom doesn't implement — same stub the
// DocumentsView / DocumentDetail specs use.
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

vi.mock('../api.js', () => ({
  api: createMockApi({
    getTaskByRef: vi.fn().mockResolvedValue({
      ref: 'learning/3',
      title: 'historical-battle-report',
      status: 'paused',
    }),
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
});
