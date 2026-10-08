import type { Question } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../../api.js', () => ({
  api: createMockApi({
    getNightShiftTasks: vi.fn().mockResolvedValue({
      background: [],
      active: [],
      upcoming: [{ ref: 'pics/3', title: 'Sort the holiday photos', projectName: 'Pictures' }],
    }),
    getNightShiftReview: vi.fn().mockRejectedValue(new Error('offline')),
    listProjects: vi.fn().mockResolvedValue({
      projects: [
        { id: 'pics', name: 'Pictures', properties: { 'gezel.folderKind': 'pictures' } },
        { id: 'app', name: 'App', properties: { 'gezel.folderKind': 'code' } },
      ],
    }),
    listPhotoAlbums: vi.fn().mockResolvedValue([
      {
        path: 'albums/2026-10-04-birthday.json',
        title: 'Birthday',
        count: 9,
        updatedAt: new Date().toISOString(),
      },
      {
        path: 'albums/2026-08-01-old.json',
        title: 'Last summer',
        count: 20,
        updatedAt: '2026-08-02T04:00:00.000Z',
      },
    ]),
    getOnThisDay: vi.fn().mockResolvedValue({
      day: '10-08',
      years: [{ year: 2023, count: 3, paths: ['2023/canal.jpg'] }],
    }),
    fetchProjectThumbnail: vi.fn().mockRejectedValue(new Error('no thumbnails in tests')),
  }),
}));

const { MorningPanel } = await import('./MorningPanel.js');

const card = {
  id: 'q1',
  projectId: 'default',
  gezelId: 'wren',
  sessionId: '',
  prompt: 'Overnight your crew read 1,204 files.',
  choices: ['Dismiss'],
  allowWriteIn: false,
  multiSelect: false,
  createdAt: '2026-10-08T06:00:00.000Z',
  intent: {
    kind: 'night-shift-review',
    windowKey: '2026-10-07',
    tasksCompleted: 0,
    reports: [],
    indexing: { filesIndexed: 1204, filesReviewed: 0, mediaDescribed: 0 },
  },
} as Question;

describe('MorningPanel', () => {
  it('leads with the morning card, then what is queued for tonight', async () => {
    render(<MorningPanel question={card} review={null} />);
    expect(await screen.findByText('Overnight your crew read 1,204 files.')).toBeInTheDocument();
    expect(await screen.findByText('Queued for tonight')).toBeInTheDocument();
    expect(screen.getByText('Sort the holiday photos')).toBeInTheDocument();
  });

  it("shows last night's albums and this day in earlier years for photo folders", async () => {
    render(<MorningPanel question={null} review={null} />);
    expect(await screen.findByText('New albums')).toBeInTheDocument();
    expect(screen.getByText('Birthday')).toBeInTheDocument();
    expect(screen.queryByText('Last summer')).toBeNull();
    expect(screen.getByText('On this day')).toBeInTheDocument();
    expect(screen.getByText('2023')).toBeInTheDocument();
  });
});
