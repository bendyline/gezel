import type { ActivityStatusResponse, Question } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../shared-chat-events.js', () => ({ streamSharedAllChatEvents: async function* () {} }));
vi.mock('./chat-bubbles.js', () => ({
  RenderedMarkdown: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
const { api } = await import('../api.js');
const { ActivityControl } = await import('./ActivityControl.js');
const { ActivityProvider } = await import('./activity-context.js');
const { openUpdates } = await import('./nav-actions.js');

const question = (id = 'q1', projectId = 'shop'): Question => ({
  id,
  projectId,
  gezelId: 'maya',
  sessionId: `s-${id}`,
  prompt: id === 'q1' ? 'Which discount should we offer?' : 'What should we call it?',
  choices: ['10%', '20%'],
  allowWriteIn: true,
  createdAt: '2026-10-02T12:00:00.000Z',
});
function snapshot(questions: Question[] = [question()]): ActivityStatusResponse {
  const at = '2026-10-02T12:00:00.000Z';
  return {
    at,
    questions,
    items: questions.map((q) => ({
      id: `question:${q.id}`,
      section: 'needs-you',
      title: q.prompt,
      detail: 'Waiting for your response.',
      projectId: q.projectId,
      gezelId: q.gezelId,
      questionIds: [q.id],
    })),
    queues: {
      at,
      providers: {},
      sessions: [],
      cache: [],
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    },
  };
}
async function mount() {
  render(
    <ActivityProvider>
      <ActivityControl />
    </ActivityProvider>,
  );
  const trigger = await screen.findByRole('button', { name: /Activity — .*needs? you/ });
  await userEvent.click(trigger);
  await screen.findAllByRole('textbox');
  return screen.getByRole('dialog', { name: 'What’s going on' });
}
async function refresh() {
  act(() => window.dispatchEvent(new Event('gezel:config-changed')));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
}

beforeEach(() => {
  vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot());
  vi.mocked(api.answerQuestion).mockImplementation(async (id, answer) => ({
    ...question(id),
    answer: { ...answer, at: '2026-10-02T12:01:00Z' },
  }));
});

describe('Activity', () => {
  it('keeps live work visible in the headline while automatic tasks are held', async () => {
    const current = snapshot([]);
    current.items = [
      {
        id: 'live',
        section: 'working',
        title: 'Write a reply',
        detail: 'Working on it.',
        questionIds: [],
      },
      {
        id: 'held',
        section: 'next',
        title: 'Newsletter',
        detail: 'Automatic work is paused.',
        heldByActivity: true,
        questionIds: [],
      },
    ];
    vi.mocked(api.getActivityStatus).mockResolvedValue(current);
    render(
      <ActivityProvider>
        <ActivityControl />
      </ActivityProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'Activity — 1 working · automatic work paused' }),
    ).toBeVisible();
  });
  it('shows every question with answer controls already visible', async () => {
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot([question(), question('q2')]));
    const dialog = await mount();
    expect(within(dialog).getAllByRole('textbox', { name: 'Add a note (optional)' })).toHaveLength(
      2,
    );
    expect(within(dialog).getAllByRole('button', { name: '20%' })).toHaveLength(2);
    expect(within(dialog).queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(within(dialog).getByRole('heading', { name: 'Needs you 2' })).toBeVisible();
  });
  it('keeps text and choices when closed, reopened, and refreshed', async () => {
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Use it through Sunday');
    await userEvent.click(screen.getByRole('button', { name: '20%' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Activity —/ }));
    await refresh();
    expect(screen.getByRole('textbox')).toHaveValue('Use it through Sunday');
    expect(screen.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('preserves question order and the draft when snapshot order changes', async () => {
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot([question(), question('q2')]));
    await mount();
    await userEvent.type(screen.getAllByRole('textbox')[0]!, 'Draft');
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot([question('q2'), question()]));
    await refresh();
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Draft');
  });
  it('keeps the panel open after answering, removes the count immediately, and ignores stale copies', async () => {
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'A weekend sale');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Activity — All quiet' })).toBeVisible(),
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Answered')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    await refresh();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.answerQuestion).toHaveBeenCalledWith('q1', { writeIn: 'A weekend sale' });
  });
  it('keeps the answer available to retry after a failed submission', async () => {
    vi.mocked(api.answerQuestion).mockRejectedValueOnce(new Error('Connection lost'));
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'A weekend sale');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('textbox')).toHaveValue('A weekend sale');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Answered')).toBeVisible();
  });
  it('does not allow a second submission after closing during an in-flight answer', async () => {
    let finish!: (question: Question) => void;
    vi.mocked(api.answerQuestion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Weekend sale');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    await userEvent.click(screen.getByRole('button', { name: /Activity —/ }));
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(api.answerQuestion).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({ ...question(), answer: { writeIn: 'Weekend sale', at: '2026-10-02T12:01:00Z' } }),
    );
    expect(await screen.findByText('Answered')).toBeVisible();
  });
  it('opens project questions in this panel and preserves other project drafts', async () => {
    vi.mocked(api.getActivityStatus).mockResolvedValue(
      snapshot([question(), question('q2', 'cafe')]),
    );
    await mount();
    await userEvent.type(screen.getAllByRole('textbox')[0]!, 'Shop draft');
    act(() => openUpdates('cafe'));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveTextContent('What should we call it?');
    await userEvent.click(screen.getByRole('button', { name: 'Show all projects' }));
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Shop draft');
  });
  it('retains last known work and exposes refresh failures instead of reporting idle', async () => {
    await mount();
    vi.mocked(api.getActivityStatus).mockRejectedValue(new Error('Offline'));
    await refresh();
    expect(screen.getByRole('button', { name: 'Activity — Status unavailable' })).toBeVisible();
    expect(screen.getByText('Status could not be refreshed.')).toBeVisible();
    expect(screen.getByRole('textbox')).toBeVisible();
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Status could not be refreshed.')).toBeNull());
  });
  it('returns keyboard focus to Activity when Escape closes the panel', async () => {
    await mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /Activity —/ })).toHaveFocus();
  });
  it('keeps one-click choices direct and preserves the meaning of Skip', async () => {
    const choice = { ...question(), allowWriteIn: false };
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot([choice, question('q2')]));
    await mount();
    const first = document.getElementById('activity-question-q1')!;
    expect(within(first).queryByRole('button', { name: 'Submit' })).toBeNull();
    await userEvent.click(within(first).getByRole('button', { name: '20%' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('q1', { selectedChoices: [1] });
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('q2', { silentSkip: true });
    expect(screen.getByRole('dialog')).toBeVisible();
  });
});
