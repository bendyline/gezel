import type { GezelSummary, RequestTrack } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { RequestTracker } = await import('./RequestTracker.js');
const { api } = await import('../api.js');

const gezels = new Map<string, GezelSummary>([
  ['dejan', { id: 'dejan', name: 'Dejan', role: 'Kantoormeester' } as GezelSummary],
  ['aditya', { id: 'aditya', name: 'Aditya', role: 'Bookkeeper' } as GezelSummary],
]);

const working: RequestTrack = {
  key: 'mees-thread@2026-10-23T09:00:00Z',
  sessionId: 'mees-thread',
  projectId: 'default',
  at: '2026-10-23T09:00:00Z',
  summary: 'Make my October invoices',
  kind: 'work',
  leadGezelId: 'dejan',
  stop: 'making',
  state: 'working',
  line: { gezelId: 'dejan', doing: 'is drafting the invoices' },
  actual: { taskRef: 'bakery/1', gezelId: 'aditya', stepId: 'draft', stepName: 'Draft' },
  eta: { remainingMs: 240_000, firstTime: false, overdue: false, text: 'About 4 minutes left' },
  taskRefs: ['bakery/1'],
  liveSessionIds: ['step-draft'],
  crew: ['aditya'],
  questionIds: [],
};

describe('RequestTracker', () => {
  it('shows four stops, the lead speaking, and how long is left', () => {
    render(<RequestTracker track={working} gezels={gezels} />);
    const stops = screen.getAllByRole('listitem').slice(0, 4);
    expect(stops.map((li) => li.textContent)).toEqual([
      'Got it',
      'Making it',
      'Checking it',
      'Ready',
    ]);
    expect(stops[1]).toHaveAttribute('aria-current', 'step');
    expect(stops[0]).toHaveClass('is-done');
    expect(screen.getByText('Dejan').closest('p')).toHaveTextContent(
      'Dejan is drafting the invoices',
    );
    expect(screen.getByText('About 4 minutes left')).toBeInTheDocument();
    // Who really holds the step, and its ref, are debug-mode text.
    expect(screen.queryByText(/bakery\/1/)).not.toBeInTheDocument();
    expect(screen.getByText('Open the task')).toBeInTheDocument();
  });

  it('names the real step and task in debug mode', () => {
    render(<RequestTracker track={working} gezels={gezels} debugMode />);
    expect(screen.getByText('Aditya · Draft · bakery/1')).toBeInTheDocument();
    expect(screen.getByText('Task bakery/1')).toBeInTheDocument();
  });

  it('offers to keep waiting or stop when a step runs long', async () => {
    vi.mocked(api.setTaskStatus).mockResolvedValue({} as never);
    const late = {
      ...working,
      eta: { ...working.eta!, overdue: true, text: 'Taking longer than usual' },
    };
    render(<RequestTracker track={late} gezels={gezels} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(screen.queryByText('Taking longer than usual.')).not.toBeInTheDocument();
    expect(screen.getByText('Still working on it')).toBeInTheDocument();
  });

  it('hands over the file at Ready, from the lead', () => {
    const ready: RequestTrack = {
      ...working,
      stop: 'ready',
      state: 'ready',
      deliverable: { kind: 'artifact', path: 'tasks/1/invoices.pdf' },
      makerGezelId: 'aditya',
    };
    delete (ready as Partial<RequestTrack>).line;
    delete (ready as Partial<RequestTrack>).eta;
    const { container } = render(<RequestTracker track={ready} gezels={gezels} />);
    const card = container.querySelector('.deliverable-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText(/Dejan/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[3]).toHaveClass('is-done');
    // No title of its own: the file name leads.
    expect(card.querySelector('.deliverable-card-name')).toHaveTextContent('invoices.pdf');
  });

  it('names the finished work by what was asked for, and a board by its project', () => {
    const ready: RequestTrack = {
      ...working,
      stop: 'ready',
      state: 'ready',
      title: 'October invoices for the three cafes',
      deliverable: { kind: 'artifact', path: 'tasks/1/invoices.pdf' },
    };
    const { container, rerender } = render(<RequestTracker track={ready} gezels={gezels} />);
    const card = container.querySelector('.deliverable-card') as HTMLElement;
    expect(card.querySelector('.deliverable-card-name')).toHaveTextContent(
      'October invoices for the three cafes',
    );
    expect(within(card).getByText('invoices.pdf')).toHaveAttribute('title', 'tasks/1/invoices.pdf');

    rerender(
      <RequestTracker
        track={{
          ...ready,
          deliverable: {
            kind: 'workspace',
            path: 'trip.json',
            projectId: 'trip',
            view: 'output-page',
          },
        }}
        gezels={gezels}
        projectName="Trip: Portugal"
      />,
    );
    const board = container.querySelector('.deliverable-card') as HTMLElement;
    expect(board.querySelector('.deliverable-card-name')).toHaveTextContent('Trip: Portugal');
    expect(within(board).getByText('Opens in the project')).toBeInTheDocument();
    expect(board).not.toHaveTextContent('trip.json');
  });

  it('is the stops and the line in an Activity row', () => {
    const { container } = render(
      <RequestTracker track={working} gezels={gezels} variant="compact" />,
    );
    expect(container.querySelector('.request-tracker-compact')).not.toBeNull();
    expect(screen.queryByText("Who's helping?")).not.toBeInTheDocument();
  });

  // A task the runtime paused once read "has a question for you" above the
  // engine's raw error, with the way to restart it two panels away.
  it('says work stopped in one sentence and restarts it from the tracker', async () => {
    const paused: RequestTrack = {
      ...working,
      state: 'needs-you',
      line: { gezelId: 'dejan', doing: 'stopped before this was finished' },
      paused: { taskRef: 'bakery/1', reason: 'step_stalled' },
      liveSessionIds: [],
    };
    delete (paused as Partial<RequestTrack>).eta;
    vi.mocked(api.retryTask).mockResolvedValue({ dispatched: true } as never);
    render(<RequestTracker track={paused} gezels={gezels} />);

    expect(screen.getByText('Dejan').closest('p')).toHaveTextContent(
      'Dejan stopped before this was finished',
    );
    expect(screen.getByTestId('request-tracker-paused')).toHaveTextContent(
      "Gezel tried this step several times and couldn't finish it. What it made so far is kept.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.retryTask).toHaveBeenCalledWith('bakery', 1));
  });

  it('says so when restarting could not put anyone to work', async () => {
    const paused: RequestTrack = {
      ...working,
      state: 'needs-you',
      line: { gezelId: 'dejan', doing: 'is waiting for you to go on' },
      paused: { taskRef: 'bakery/1' },
    };
    vi.mocked(api.retryTask).mockResolvedValue({
      dispatched: false,
      reason: 'no-assignee',
    } as never);
    render(<RequestTracker track={paused} gezels={gezels} />);

    expect(screen.getByTestId('request-tracker-paused')).toHaveTextContent(
      'What it made so far is kept.',
    );
    // The person stopped this one, so the key carries on instead of retrying.
    fireEvent.click(screen.getByRole('button', { name: 'Carry on' }));
    await screen.findByText(/nothing could pick it up/);
  });
});
