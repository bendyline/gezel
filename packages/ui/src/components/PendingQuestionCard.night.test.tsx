import type { Question } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

// Same jsdom gap the nav spec papers over: the markdown renderer reaches
// `useEffectiveTheme`, which subscribes to `window.matchMedia`.
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const COVERAGE_JSON = '{\n  "batchNumber": 18,\n  "reviewedFiles": []\n}\n';

vi.mock('../api.js', () => ({
  api: createMockApi({
    readDocument: vi.fn().mockResolvedValue({ content: COVERAGE_JSON, kind: 'artifact' }),
    getNightShiftReview: vi.fn().mockResolvedValue({
      windowKey: '2026-08-25',
      windowStart: '2026-08-25T22:00:00.000Z',
      windowEnd: '2026-08-26T06:00:00.000Z',
      tasksCompleted: [
        {
          ref: 'default/18',
          title: 'Coverage sweep for PR-41',
          projectId: 'default',
          projectName: 'Default',
        },
      ],
      reports: [
        {
          projectId: 'default',
          projectName: 'Default',
          path: 'reports/night-2026-08-25.md',
          title: 'What the night shift found',
          actionCounts: { total: 3, suggested: 2, fired: 1, applied: 0, dismissed: 0 },
        },
      ],
      diffpacks: [],
    }),
  }),
}));

const { PendingQuestionCard } = await import('./PendingQuestionCard.js');
const { api } = await import('../api.js');

function nightCard(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'default',
    gezelId: 'wren',
    sessionId: '',
    prompt: 'The night shift finished 1 task and left 1 report for you.',
    choices: ['Dismiss'],
    allowWriteIn: false,
    multiSelect: false,
    createdAt: '2026-08-26T06:00:00.000Z',
    intent: {
      kind: 'night-shift-review',
      windowKey: '2026-08-25',
      tasksCompleted: 1,
      reports: [
        {
          projectId: 'default',
          path: 'reports/night-2026-08-25.md',
          title: 'What the night shift found',
          actionCount: 2,
        },
      ],
    },
    ...over,
  } as Question;
}

describe('night-shift review card', () => {
  it('reads as a hand-off note with the work named, not a tally', async () => {
    render(<PendingQuestionCard question={nightCard()} />);

    await screen.findByText(
      'The night shift finished 1 task and left 1 report for you. There are 2 suggested actions to review.',
    );
    // The work itself, not just its count.
    expect(screen.getByText('Coverage sweep for PR-41')).toBeTruthy();
    expect(screen.getByText('What the night shift found')).toBeTruthy();
  });

  // Landing on the owning project and hunting the artifacts drawer for the
  // file we just named by title is a step the user shouldn't have to take.
  it('opens the named report itself', async () => {
    const opened = vi.fn();
    window.addEventListener('gezel:open-tab', opened);
    render(<PendingQuestionCard question={nightCard()} />);

    fireEvent.click(await screen.findByText('What the night shift found'));
    window.removeEventListener('gezel:open-tab', opened);

    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      kind: 'document',
      path: 'projects/default/artifacts/reports/night-2026-08-25.md',
    });
  });

  // The lead report is lifted into the column beside the card, so a row
  // linking to the page the reader is already looking at is noise.
  it('drops the report row for the report already on screen', async () => {
    vi.mocked(api.readDocument).mockResolvedValueOnce({
      content: '# What the night shift found\n\nOne finding.\n',
      kind: 'artifact',
    } as never);
    const { container } = render(
      <PendingQuestionCard
        question={nightCard({
          documentPath: 'projects/default/artifacts/reports/night-2026-08-25.md',
        })}
      />,
    );

    await screen.findByText('Coverage sweep for PR-41');
    expect(container.querySelector('.pending-question-document-panel')).not.toBeNull();
    expect(container.querySelectorAll('.pending-question-night-row')).toHaveLength(1);
  });

  // The regression this card was fixed for: a step's data deliverable was
  // counted as "1 report written" and dumped into the tall document column
  // as a raw literal. Old cards on disk still carry one.
  it('keeps a data attachment out of the document panel', async () => {
    const { container } = render(
      <PendingQuestionCard
        question={nightCard({ documentPath: 'projects/default/artifacts/coverage-18.json' })}
      />,
    );

    await screen.findByText('Coverage sweep for PR-41');
    expect(container.querySelector('.pending-question-document-panel')).toBeNull();
    expect(container.querySelector('.pending-question-splitwrap')).toBeNull();
  });
});
