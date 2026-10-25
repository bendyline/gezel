import type { GezelSummary, RequestTrack } from '@bendyline/gezel';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  });

  it('is the stops and the line in an Activity row', () => {
    const { container } = render(
      <RequestTracker track={working} gezels={gezels} variant="compact" />,
    );
    expect(container.querySelector('.request-tracker-compact')).not.toBeNull();
    expect(screen.queryByText("Who's helping?")).not.toBeInTheDocument();
  });
});
