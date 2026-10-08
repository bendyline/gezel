import type { Question, Task } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { VisitCard, pickVisitItem } = await import('./VisitCard.js');
const { api } = await import('../api.js');

const NOW = Date.parse('2026-10-07T12:00:00Z');

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'p',
    gezelId: 'anna',
    sessionId: 's1',
    prompt: 'Which week suits you?',
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    projectId: 'p',
    num: 4,
    ref: 'p/4',
    title: 'Plan the trip',
    status: 'complete',
    assignee: { kind: 'gezel', gezelId: 'anna' },
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-07T09:00:00Z',
    createdBy: { kind: 'user' },
    ...overrides,
  } as Task;
}

function setSocial(social: boolean) {
  act(() => {
    window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: { social } }));
  });
}

describe('pickVisitItem', () => {
  beforeEach(() => window.localStorage.clear());

  it('puts an open question first, then a recent result of this gezel', () => {
    expect(pickVisitItem('anna', [question()], [task()], NOW)).toMatchObject({
      kind: 'question',
      text: 'Which week suits you?',
    });
    expect(pickVisitItem('anna', [], [task()], NOW)).toMatchObject({
      kind: 'result',
      taskRef: 'p/4',
    });
  });

  it('leaves out other gezels, answered questions, old results, and shards', () => {
    const answered = question({ answer: { at: '2026-10-07T11:00:00Z', writeIn: 'June' } });
    expect(
      pickVisitItem(
        'anna',
        [question({ gezelId: 'bram' }), answered],
        [
          task({ assignee: { kind: 'gezel', gezelId: 'bram' } }),
          task({ updatedAt: '2026-09-30T09:00:00Z' }),
          task({ parentTaskRef: 'p/3' }),
          task({ status: 'active' }),
        ],
        NOW,
      ),
    ).toBeNull();
  });
});

describe('VisitCard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [] });
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  });

  it('shows nothing while social mode is off', async () => {
    setSocial(false);
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [question()] });
    render(<VisitCard gezelId="anna" gezelName="Anna" projectId="p" />);
    await act(async () => {});
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(api.listQuestions).not.toHaveBeenCalled();
  });

  it('opens a finished task and stays dismissed', async () => {
    setSocial(true);
    vi.mocked(api.listProjectTasks).mockResolvedValue({
      tasks: [task({ updatedAt: new Date().toISOString() })],
    });
    const onOpenTask = vi.fn();
    const { unmount } = render(
      <VisitCard gezelId="anna" gezelName="Anna" projectId="p" onOpenTask={onOpenTask} />,
    );
    expect(await screen.findByText('Anna finished “Plan the trip”.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenTask).toHaveBeenCalledWith('p/4');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Anna finished/)).toBeNull();
    unmount();

    render(<VisitCard gezelId="anna" gezelName="Anna" projectId="p" />);
    await waitFor(() => expect(api.listProjectTasks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Anna finished/)).toBeNull();
  });
});
