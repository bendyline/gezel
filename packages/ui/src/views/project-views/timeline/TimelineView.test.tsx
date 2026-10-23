import type { ProjectDetail, TimelineBucketResponse, TimelineResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TimelineProjectView from './index.js';

vi.mock('../../../api.js', () => ({
  api: {
    getTimeline: vi.fn(),
    getTimelineBucket: vi.fn(),
    fetchProjectThumbnail: vi.fn(),
  },
}));

const { api } = await import('../../../api.js');
const getTimeline = vi.mocked(api.getTimeline);
const getTimelineBucket = vi.mocked(api.getTimelineBucket);
vi.mocked(api.fetchProjectThumbnail).mockRejectedValue(new Error('no thumbnails in tests'));

const TIMELINE: TimelineResponse = {
  indexed: true,
  source: 'git',
  bucket: 'week',
  lanes: [
    { id: 'src', label: 'src' },
    { id: 'docs', label: 'docs' },
  ],
  buckets: [
    {
      start: '2026-10-05',
      end: '2026-10-12',
      label: 'Week of October 5, 2026',
      commits: 2,
      files: 3,
      lanes: { src: 3 },
    },
    {
      start: '2026-10-12',
      end: '2026-10-19',
      label: 'Week of October 12, 2026',
      commits: 0,
      files: 0,
      lanes: {},
    },
    {
      start: '2026-10-19',
      end: '2026-10-26',
      label: 'Week of October 19, 2026',
      commits: 1,
      files: 1,
      lanes: { docs: 1 },
    },
  ],
  truncated: false,
};

const detailFor = (start: string): TimelineBucketResponse => ({
  start,
  end: '',
  source: 'git',
  commits:
    start === '2026-10-19'
      ? [
          {
            sha: 'c3',
            at: '2026-10-20T08:00:00.000Z',
            subject: 'Tidy the guide',
            files: ['docs/guide.md'],
            fileCount: 1,
          },
        ]
      : [
          {
            sha: 'c2',
            at: '2026-10-07T08:00:00.000Z',
            subject: 'Teach the parser lists',
            files: ['src/parser.ts', 'src/lexer.ts'],
            fileCount: 14,
          },
        ],
  files: [
    {
      path: start === '2026-10-19' ? 'docs/guide.md' : 'src/parser.ts',
      name: start === '2026-10-19' ? 'guide.md' : 'parser.ts',
      type: 'note',
      typeLabel: 'Note',
      family: 'documents',
      size: 10,
      mtimeMs: Date.now(),
      changes: 2,
    },
  ],
  truncated: false,
});

const project = { id: 'p1', name: 'Demo', packages: [] } as unknown as ProjectDetail;

function renderTimeline() {
  const onSelectPath = vi.fn();
  render(
    <TimelineProjectView
      projectId="p1"
      project={project}
      compact={false}
      selectedPath={null}
      onSelectPath={onSelectPath}
      setInspectorExtras={vi.fn()}
    />,
  );
  return { onSelectPath };
}

beforeEach(() => {
  getTimeline.mockReset();
  getTimelineBucket.mockReset();
  getTimeline.mockResolvedValue(TIMELINE);
  getTimelineBucket.mockImplementation(async (_id, req) => detailFor(req.start));
  window.localStorage.clear();
});

describe('TimelineProjectView', () => {
  it('opens on the newest stretch and lists its commits', async () => {
    renderTimeline();
    const detail = await screen.findByRole('region', { name: 'Week of October 19, 2026' });
    expect(await within(detail).findByText('Tidy the guide')).toBeInTheDocument();
    expect(getTimelineBucket).toHaveBeenCalledWith('p1', {
      start: '2026-10-19',
      end: '2026-10-26',
      source: 'git',
    });
    expect(screen.getByRole('list', { name: 'What the colors mean' })).toHaveTextContent('srcdocs');
  });

  it('selects a stretch by its bar or the arrow keys, and opens a file it names', async () => {
    const { onSelectPath } = renderTimeline();
    await screen.findByText('Tidy the guide');
    const axis = screen.getByRole('toolbar', { name: 'Activity over time' });
    fireEvent.click(
      within(axis).getByRole('button', { name: /October 5, 2026: 2 commits, 3 files/ }),
    );
    expect(await screen.findByText('Teach the parser lists')).toBeInTheDocument();
    expect(screen.getByText('and 12 more')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'lexer.ts' }));
    expect(onSelectPath).toHaveBeenCalledWith('src/lexer.ts');

    fireEvent.keyDown(axis, { key: 'End' });
    expect(await screen.findByText('Tidy the guide')).toBeInTheDocument();
    expect(getTimelineBucket).toHaveBeenCalledTimes(2);
  });

  it('switches to months and remembers it', async () => {
    renderTimeline();
    await screen.findByText('Tidy the guide');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Bars' })).getByText('Months'));
    await waitFor(() => expect(getTimeline).toHaveBeenLastCalledWith('p1', { bucket: 'month' }));
    expect(window.localStorage.getItem('gezel.timeline.bucket.p1')).toBe('month');
  });

  it('says when nothing has a date yet', async () => {
    getTimeline.mockResolvedValue({ ...TIMELINE, buckets: [], lanes: [] });
    renderTimeline();
    expect(await screen.findByText('Nothing here has a date yet.')).toBeInTheDocument();
  });
});
