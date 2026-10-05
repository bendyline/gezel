import type { Question } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { PendingQuestionCard } from './PendingQuestionCard.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});

function permissionQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'permission-1',
    projectId: 'slides',
    gezelId: 'ada',
    sessionId: 's1',
    prompt: 'I need to save the presentation.',
    createdAt: '2026-10-05T00:00:00Z',
    choices: ['Only one harmless file', 'Deny'],
    intent: {
      kind: 'workspace-write-permission',
      projectName: 'Slides',
      workspaceDir: 'D:/Projects/Slides',
      realWorkspaceDir: 'D:/Projects/Slides',
    },
    ...overrides,
  };
}

describe('project permission card', () => {
  beforeEach(() => {
    vi.mocked(api.answerQuestion).mockReset();
  });

  it('shows the real scope and immediately submits an explicit grant', async () => {
    const question = permissionQuestion();
    const answered = { ...question, answer: { selectedChoices: [0], at: 'now' } };
    vi.mocked(api.answerQuestion).mockResolvedValueOnce(answered);
    const onAnswered = vi.fn();
    render(<PendingQuestionCard question={question} onAnswered={onAnswered} />);
    expect(screen.getByText('Permission request')).toBeInTheDocument();
    expect(screen.getByText('D:/Projects/Slides')).toBeInTheDocument();
    expect(screen.getByText('Create, edit, rename and delete project files')).toBeInTheDocument();
    expect(
      screen.getByText(/All gezels using built-in tools, scripts and background work/),
    ).toBeInTheDocument();
    expect(screen.getByText('Until revoked, including future tasks')).toBeInTheDocument();
    expect(screen.queryByText('Only one harmless file')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    const grant = screen.getByRole('button', { name: 'Allow project file edits and continue' });
    expect(grant.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(grant);
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(answered));
    expect(api.answerQuestion).toHaveBeenCalledExactlyOnceWith(question.id, {
      selectedChoices: [0],
    });
  });

  it('keeps the request actionable when the service refuses a stale grant', async () => {
    vi.mocked(api.answerQuestion).mockRejectedValueOnce(new Error('The project folder changed.'));
    render(<PendingQuestionCard question={permissionQuestion()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow project file edits and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The project folder changed.');
    expect(
      screen.getByRole('button', { name: 'Allow project file edits and continue' }),
    ).toBeEnabled();
  });

  it('submits denial as a decision, and describes it as unchanged permissions', async () => {
    const question = permissionQuestion();
    const answered = { ...question, answer: { selectedChoices: [1], at: 'now' } };
    vi.mocked(api.answerQuestion).mockResolvedValueOnce(answered);
    const { rerender } = render(<PendingQuestionCard question={question} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep current permissions' }));
    await waitFor(() =>
      expect(api.answerQuestion).toHaveBeenCalledWith(question.id, { selectedChoices: [1] }),
    );
    rerender(<PendingQuestionCard question={answered} />);
    expect(screen.getByText(/Permissions unchanged:/)).toBeInTheDocument();
    expect(screen.queryByText(/Proceed with defaults/)).toBeNull();
  });
});
