import type { ChatSession, Question, Task, TaskNote } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type FigureReviewStore, renderFigureReview, reviewTaskFigures } from './figure-review.js';

const QUOTE = `## Option 2: Fresh Fruit & Coffee Service

| Item | Quantity | Price per Unit | Subtotal |
|------|----------|----------------|----------|
| Seasonal Fruit Platter | 1 | $85.00 | $85.00 |
| Coffee Service | 1 | $45.00 | $45.00 |
| Assorted Pastries | 12 | $3.50 | $42.00 |
| Delivery Fee | 1 | $25.00 | $25.00 |
| **Subtotal** | | | **$297.00** |

Event: Friday, October 10 at 8am.
`;

const task = {
  projectId: 'default',
  num: 2,
  ref: 'default/2',
  title: 'Catering quote',
  description: 'Quote for Maya Chen',
  launchSessionId: 'thread-1',
} as Task;

function fakeStore(files: Record<string, string>): FigureReviewStore {
  const thread = {
    id: 'thread-1',
    messages: [
      { role: 'user', content: 'Budget about $300. Croissants $3.50, delivery $25.', at: 'x' },
      // The model's own words are not a price source.
      { role: 'assistant', content: 'A fruit platter is usually $85.', at: 'x' },
      {
        role: 'user',
        content: 'Coffee is $45',
        at: 'x',
        origin: 'system',
      },
    ],
  } as unknown as ChatSession;
  return {
    findSessionById: async (id) => (id === 'thread-1' ? thread : null),
    readProjectArtifact: async (_projectId, path) => files[path] ?? null,
    readProjectWorkspaceFile: async () => null,
    listProjectWorkspace: async () => [],
    listTaskNotes: async () => [] as TaskNote[],
    listProjectQuestions: async () => [] as Question[],
    getProject: async () => ({ id: 'default', name: 'Default' }) as never,
  };
}

describe('reviewTaskFigures', () => {
  // The review run's quote: $297 over items adding to $197, a Friday that
  // was a Saturday, and two prices the owner never gave.
  it("names what's wrong in the owner's words, file by file", async () => {
    const review = await reviewTaskFigures(
      fakeStore({ 'tasks/2/quote.md': QUOTE, 'tasks/2/weekly_review_2024-05-20.md': 'Notes.' }),
      task,
      [
        { kind: 'artifact', path: 'tasks/2/quote.md' },
        { kind: 'artifact', path: 'tasks/2/weekly_review_2024-05-20.md' },
        { kind: 'artifact', path: 'tasks/2/flyer.png' },
      ],
      { today: '2026-09-28' },
    );
    expect(review?.problems).toEqual([
      'Under "Option 2: Fresh Fruit & Coffee Service", the subtotal says $297.00, but the items above it add up to $197.00. (`quote.md`)',
      'October 10, 2026 is a Saturday, not a Friday. (`quote.md`)',
      "Prices in `quote.md` that didn't come from you: Seasonal Fruit Platter $85.00 and Coffee Service $45.00.",
      'The file name `weekly_review_2024-05-20.md` has a date that has already passed.',
    ]);
    expect(renderFigureReview(review, 'Before you approve, check:')[0]).toBe(
      'Before you approve, check:',
    );
  });

  it('says plainly when the numbers it checked hold up, and nothing more', async () => {
    const good = QUOTE.replace('$297.00', '$197.00')
      .replace('Friday, October 10', 'Saturday, October 10')
      .replace('$85.00 | $85.00', '$3.50 | $3.50')
      .replace('$45.00 | $45.00', '$25.00 | $25.00')
      .replace('**$197.00**', '**$95.50**');
    const review = await reviewTaskFigures(
      fakeStore({ 'tasks/2/quote.md': good }),
      task,
      [{ kind: 'artifact', path: 'tasks/2/quote.md' }],
      { today: '2026-09-28' },
    );
    expect(review).toEqual({ problems: [], checked: ['sums', 'prices', 'dates'] });
    expect(renderFigureReview(review, 'Before you approve, check:')).toEqual([
      'I checked the sums, prices and dates in these files, and they hold up.',
    ]);
  });

  it('has nothing to say about files it cannot read as text', async () => {
    const review = await reviewTaskFigures(
      fakeStore({}),
      task,
      [{ kind: 'artifact', path: 'tasks/2/deck.pptx' }],
      { today: '2026-09-28' },
    );
    expect(review).toBeNull();
    expect(renderFigureReview(review, 'x')).toEqual([]);
  });
});
