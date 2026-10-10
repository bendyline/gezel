import {
  type ActivityStatusResponse,
  type Question,
  type Task,
  isReadyQuestion,
} from '@bendyline/gezel';
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
      section: isReadyQuestion(q) ? 'ready' : 'needs-you',
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
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot());
  vi.mocked(api.answerQuestion).mockImplementation(async (id, answer) => ({
    ...question(id),
    answer: { ...answer, at: '2026-10-02T12:01:00Z' },
  }));
});

describe('Activity', () => {
  it('opens Ready ahead of pending advice and follows new destinations without stealing focus on refresh', async () => {
    const finished: Question[] = [1, 2, 3].map((i) => ({
      ...question(`ready-${i}`),
      prompt: `Report ${i} is finished.`,
      intent: { kind: 'task-finished', taskRef: `shop/${i}` },
    }));
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot([question(), ...finished]));
    render(
      <ActivityProvider>
        <ActivityControl />
      </ActivityProvider>,
    );
    const trigger = await screen.findByRole('button', { name: 'Activity — 1 needs you' });
    act(() => openUpdates({ section: 'ready' }));
    const ready = await screen.findByRole('heading', { name: 'Ready 3' });
    await waitFor(() => expect(ready).toHaveFocus());
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.instances.at(-1)).toBe(
      screen.getByRole('region', { name: 'Ready' }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Needs you 1' }));
    const needs = screen.getByRole('heading', { name: 'Needs you 1' });
    await waitFor(() => expect(needs).toHaveFocus());
    await refresh();
    expect(needs).toHaveFocus();

    act(() => openUpdates({ section: 'ready' }));
    await waitFor(() => expect(ready).toHaveFocus());
    act(() => openUpdates({ section: 'needs-you' }));
    await waitFor(() => expect(needs).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Close Activity' })).toHaveFocus();
  });

  it('keeps the requested section until Activity finishes loading', async () => {
    let finish!: (value: ActivityStatusResponse) => void;
    vi.mocked(api.getActivityStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <ActivityProvider>
        <ActivityControl />
      </ActivityProvider>,
    );
    act(() => openUpdates({ section: 'ready' }));
    expect(await screen.findByText('Checking your work…')).toBeVisible();
    await act(async () => finish(snapshot()));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ready 0' })).toHaveFocus());
  });

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
    act(() => openUpdates({ projectId: 'cafe' }));
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

describe('Activity human steps without a question card', () => {
  const task = (): Task =>
    ({
      ref: 'shop/1',
      projectId: 'shop',
      num: 1,
      title: 'Autumn newsletter',
      status: 'active',
      assignee: { kind: 'user' },
      activeStepId: 'brief',
      craftbook: {
        id: 'newsletter',
        name: 'Newsletter',
        steps: [
          {
            id: 'brief',
            name: 'Choose the offer',
            description: 'Tell Maya which offer to feature.',
            createdAt: '2026-10-02T12:00:00Z',
            lastActivatedAt: '2026-10-02T12:00:00Z',
          },
          {
            id: 'write',
            name: 'Write the newsletter',
            assignee: { kind: 'gezel', gezelId: 'maya' },
            createdAt: '2026-10-02T12:00:00Z',
          },
        ],
      },
      createdAt: '2026-10-02T12:00:00Z',
      updatedAt: '2026-10-02T12:00:00Z',
    }) as Task;
  beforeEach(() => {
    const current = snapshot([]);
    current.items = [
      {
        id: 'task:shop/1',
        section: 'needs-you',
        title: 'Autumn newsletter',
        detail: 'Your step is ready. Open the task to continue.',
        taskRef: 'shop/1',
        projectId: 'shop',
        questionIds: [],
      },
    ];
    vi.mocked(api.getActivityStatus).mockResolvedValue(current);
    vi.mocked(api.getTaskByRef).mockResolvedValue(task());
    vi.mocked(api.appendTaskNote).mockResolvedValue({ note: { id: 'note-1' } } as never);
    vi.mocked(api.completeTaskStep).mockResolvedValue({
      task: { ...task(), activeStepId: 'write' },
    });
  });
  it('shows the step and saves direction before advancing, with no navigation required', async () => {
    const dialog = await mount();
    expect(within(dialog).getByText('Current step: Choose the offer')).toBeVisible();
    expect(within(dialog).getByText('Tell Maya which offer to feature.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Open task' })).toBeNull();
    expect(within(dialog).queryByText(/Open the task to continue/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue task' })).toBeDisabled();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should happen next?' }),
      'Use a 20% weekend offer.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Next step: Write the newsletter');
    expect(api.appendTaskNote).toHaveBeenCalledWith('shop', 1, {
      text: 'Use a 20% weekend offer.',
      stepId: 'brief',
    });
    expect(api.completeTaskStep).toHaveBeenCalledWith('shop', 1, 'brief');
    expect(vi.mocked(api.appendTaskNote).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.completeTaskStep).mock.invocationCallOrder[0]!,
    );
    expect(dialog).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    await refresh();
    expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull();
  });
  it.each(['task', 'step'] as const)(
    'shows the %s assignment expectation ahead of general prose',
    async (scope) => {
      const current = task();
      const instructions = 'Add the launch date to the description, then confirm it here.';
      current.assignee = {
        kind: 'user',
        instructions: scope === 'task' ? instructions : 'General task instructions',
      };
      if (scope === 'step') current.craftbook.steps[0]!.assignee = { kind: 'user', instructions };
      vi.mocked(api.getTaskByRef).mockResolvedValue(current);
      const dialog = await mount();
      expect(within(dialog).getByText(instructions)).toBeVisible();
      expect(within(dialog).queryByText('Tell Maya which offer to feature.')).toBeNull();
      expect(within(dialog).queryByText('General task instructions')).toBeNull();
      expect(
        within(dialog).getByRole('textbox', { name: 'What should happen next?' }),
      ).toBeVisible();
    },
  );

  it.each([
    ['Pause task', 'paused', 'Task paused. You can resume it later.'],
    ['Cancel task', 'canceled', 'Task canceled. Its notes and files are kept.'],
  ] as const)(
    'can %s above the textbox without submitting a direction',
    async (label, status, receipt) => {
      vi.mocked(api.setTaskStatus).mockResolvedValue({ ...task(), status });
      const dialog = await mount();
      const button = within(dialog).getByRole('button', { name: label });
      const textbox = within(dialog).getByRole('textbox');
      expect(
        button.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await userEvent.click(button);
      expect(await screen.findByRole('status')).toHaveTextContent(receipt);
      expect(api.setTaskStatus).toHaveBeenCalledWith('shop', 1, status);
      expect(api.appendTaskNote).not.toHaveBeenCalled();
      expect(api.completeTaskStep).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(dialog).toBeVisible();
    },
  );

  it('keeps the draft after a failed pause and when the task is later resumed', async () => {
    vi.mocked(api.setTaskStatus)
      .mockRejectedValueOnce(new Error('Could not pause the task'))
      .mockResolvedValueOnce({ ...task(), status: 'paused' });
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Keep the subscriber offer');
    await userEvent.click(screen.getByRole('button', { name: 'Pause task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not pause');
    expect(screen.getByRole('textbox')).toHaveValue('Keep the subscriber offer');
    expect(screen.getByRole('button', { name: 'Continue task' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Pause task' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Task paused');
    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    // The task has been resumed elsewhere, without advancing this human step.
    vi.mocked(api.getTaskByRef).mockResolvedValue(task());
    await userEvent.click(screen.getByRole('button', { name: /Activity —/ }));
    expect(await screen.findByRole('textbox')).toHaveValue('Keep the subscriber offer');
    expect(screen.getByRole('button', { name: 'Continue task' })).toBeEnabled();
  });

  it('blocks competing actions while a cancel request is pending', async () => {
    let finish!: (task: Task) => void;
    vi.mocked(api.setTaskStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(screen.getByRole('button', { name: 'Canceling…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue task' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => finish({ ...task(), status: 'canceled' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Task canceled');
    expect(api.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(api.completeTaskStep).not.toHaveBeenCalled();
  });

  it('keeps direction through close, refresh, and reopen', async () => {
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Only for subscribers');
    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    await refresh();
    await userEvent.click(screen.getByRole('button', { name: /Activity —/ }));
    expect(await screen.findByRole('textbox')).toHaveValue('Only for subscribers');
  });
  it('keeps the draft and retries completion without duplicating its saved note', async () => {
    vi.mocked(api.completeTaskStep).mockRejectedValueOnce(new Error('Connection lost'));
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('textbox')).toHaveValue('Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Next step');
    expect(api.appendTaskNote).toHaveBeenCalledTimes(1);
    expect(api.completeTaskStep).toHaveBeenCalledTimes(2);
  });
  it('shows a completion check failure and updates the saved direction on retry', async () => {
    vi.mocked(api.completeTaskStep).mockResolvedValueOnce({
      task: task(),
      gate: {
        decision: 'reject',
        message: 'Choose an offer first.',
        attempt: 1,
        maxAttempts: 3,
        paused: false,
      },
    });
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Start the newsletter');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an offer first.');
    expect(screen.queryByRole('status')).toBeNull();
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Next step');
    expect(api.updateTaskNote).toHaveBeenCalledWith('shop', 1, 'note-1', { text: 'Use 20%' });
    expect(api.appendTaskNote).toHaveBeenCalledTimes(1);
  });
  it('does not advance if saving the direction fails', async () => {
    vi.mocked(api.appendTaskNote).mockRejectedValueOnce(new Error('Could not save your direction'));
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(api.completeTaskStep).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Use 20%');
  });
  it('refuses a stale step before writing or advancing anything', async () => {
    await mount();
    vi.mocked(api.getTaskByRef).mockResolvedValue({ ...task(), activeStepId: 'write' });
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This step has changed');
    expect(api.appendTaskNote).not.toHaveBeenCalled();
    expect(api.completeTaskStep).not.toHaveBeenCalled();
  });
  it('shows the next human step with a fresh textbox when the snapshot changes', async () => {
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'The previous direction');
    const nextTask = task();
    nextTask.activeStepId = 'write';
    nextTask.craftbook.steps[1]!.assignee = { kind: 'user' };
    vi.mocked(api.getTaskByRef).mockResolvedValue(nextTask);
    const nextSnapshot = snapshot([]);
    nextSnapshot.at = '2026-10-02T12:01:00Z';
    nextSnapshot.items = [
      {
        id: 'task:shop/1',
        section: 'needs-you',
        title: nextTask.title,
        detail: 'Waiting for your direction.',
        taskRef: nextTask.ref,
        projectId: nextTask.projectId,
        questionIds: [],
      },
    ];
    vi.mocked(api.getActivityStatus).mockResolvedValue(nextSnapshot);
    await refresh();
    expect(await screen.findByText('Current step: Write the newsletter')).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('prevents resubmission after closing during continuation', async () => {
    let finish!: (result: { task: Task }) => void;
    vi.mocked(api.completeTaskStep).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await userEvent.type(screen.getByRole('textbox'), 'Use 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    await waitFor(() => expect(api.completeTaskStep).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Close Activity' }));
    await userEvent.click(screen.getByRole('button', { name: /Activity —/ }));
    expect(await screen.findByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continuing…' })).toBeDisabled();
    await act(async () =>
      finish({ task: { ...task(), status: 'complete', activeStepId: undefined } }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('This task is complete');
    expect(api.completeTaskStep).toHaveBeenCalledTimes(1);
  });
});

describe('Activity crew rows', () => {
  function crewSnapshot(): ActivityStatusResponse {
    const current = snapshot([]);
    current.queues.providers = {
      mlx: {
        running: 1,
        queuedInteractive: 2,
        queuedBackground: 0,
        concurrency: 2,
        maxConcurrency: 1,
        active: [
          {
            sessionId: 's-run',
            gezelId: 'maya',
            projectId: 'shop',
            job: 'shop/1 · write',
            runningForMs: 12_000,
          },
        ],
        pending: [
          {
            id: 7,
            lane: 'interactive',
            sessionId: 's-wait-a',
            gezelId: 'maya',
            projectId: 'shop',
            waitedMs: 4_000,
          },
          {
            id: 8,
            lane: 'interactive',
            sessionId: 's-wait-b',
            gezelId: 'maya',
            projectId: 'shop',
            waitedMs: 2_000,
          },
        ],
      },
    };
    current.items = [
      {
        id: 'task:shop/1',
        section: 'working',
        title: 'Autumn newsletter',
        detail: 'Working on it.',
        projectId: 'shop',
        gezelId: 'maya',
        taskRef: 'shop/1',
        sessionId: 's-run',
        questionIds: [],
      },
      {
        id: 'session:s-wait-a',
        section: 'next',
        title: 'Draft the welcome email',
        detail: 'Waiting for a free model slot.',
        projectId: 'shop',
        gezelId: 'maya',
        sessionId: 's-wait-a',
        questionIds: [],
      },
      {
        id: 'session:s-wait-b',
        section: 'next',
        title: 'Summarize the reviews',
        detail: 'Waiting for a free model slot.',
        projectId: 'shop',
        gezelId: 'maya',
        sessionId: 's-wait-b',
        questionIds: [],
      },
      {
        id: 'task:shop/2',
        section: 'next',
        title: 'Spring catalog',
        detail: 'Scheduled for the next Night Shift.',
        projectId: 'shop',
        taskRef: 'shop/2',
        questionIds: [],
      },
    ];
    return current;
  }
  async function openCrew() {
    vi.mocked(api.getActivityStatus).mockResolvedValue(crewSnapshot());
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'maya', name: 'Maya', role: 'Writer' }],
    } as never);
    render(
      <ActivityProvider>
        <ActivityControl />
      </ActivityProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Activity — 1 working/ }));
    return screen.getByRole('dialog', { name: 'What’s going on' });
  }

  it('lists the running gezel under Working with Stop, once', async () => {
    const dialog = await openCrew();
    const working = within(dialog).getByRole('region', { name: 'Working' });
    const stop = await within(working).findByRole('button', { name: 'Stop active chat with Maya' });
    expect(within(working).getByText(/Autumn newsletter/)).toBeVisible();
    expect(
      within(working).getByRole('button', { name: 'View task details for Autumn newsletter' }),
    ).toBeVisible();
    // The row stands in for the activity entry instead of repeating it.
    expect(within(working).queryByRole('button', { name: 'View task details' })).toBeNull();
    await userEvent.click(stop);
    expect(api.cancelChatSessionTurn).toHaveBeenCalledWith('s-run', { stopTask: true });
  });

  it('lists waiting gezels under Next with reorder and cancel, before scheduled work', async () => {
    const dialog = await openCrew();
    const next = within(dialog).getByRole('region', { name: 'Next' });
    const up = within(next).getAllByRole('button', { name: 'Move up' });
    const down = within(next).getAllByRole('button', { name: 'Move down' });
    expect(up).toHaveLength(2);
    expect(up[0]).toBeDisabled();
    expect(down[1]).toBeDisabled();
    expect(within(next).getByText(/Draft the welcome email/)).toBeVisible();
    expect(within(next).queryByText('Waiting for a free model slot.')).toBeNull();
    expect(within(next).getByText('Spring catalog')).toBeVisible();
    await userEvent.click(down[0]!);
    expect(api.moveProviderQueueItem).toHaveBeenCalledWith('mlx', 7, 'down');
    await userEvent.click(within(next).getAllByRole('button', { name: 'Cancel queued turn' })[1]!);
    expect(api.cancelProviderQueueItem).toHaveBeenCalledWith('mlx', 8);
  });
});
