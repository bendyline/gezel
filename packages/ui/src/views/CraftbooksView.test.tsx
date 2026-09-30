import type { CraftbookSummary } from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock('../components/useCompactLayout.js', () => ({ useCompactLayout: () => layout.compact }));
vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./CraftbookEditor.js', () => ({
  CraftbookEditor: ({ craftbookId }: { craftbookId: string }) => (
    <div data-testid="mock-craftbook-editor">{craftbookId}</div>
  ),
}));

const { CraftbooksView } = await import('./CraftbooksView.js');
const { api } = await import('../api.js');

const CRAFTBOOKS: CraftbookSummary[] = [
  {
    id: 'release-review',
    name: 'Release review',
    description: 'Check a release before shipping.',
    source: 'local',
    stepCount: 3,
  },
  {
    id: 'battle-report',
    name: 'Historical battle report',
    description: 'Research and publish a battle report.',
    source: 'bundled',
    stepCount: 6,
  },
];

describe('CraftbooksView', () => {
  beforeEach(() => {
    layout.compact = false;
    vi.mocked(api.listCraftbooks).mockResolvedValue({ craftbooks: CRAFTBOOKS } as never);
  });

  it('on a phone, shows the library first and opens a book in its place', async () => {
    layout.compact = true;
    const user = userEvent.setup();
    const { container } = render(<CraftbooksView />);

    const rail = container.querySelector('.craftbooks-sidebar')!;
    const editor = container.querySelector('.craftbooks-detail')!;
    await screen.findByText('Release review');
    // The first book is selected for desktop, but a phone lands on the list.
    expect(rail).not.toHaveAttribute('hidden');
    expect(editor).toHaveAttribute('hidden');

    await user.click(screen.getByRole('button', { name: /Historical battle report/ }));
    expect(rail).toHaveAttribute('hidden');
    expect(editor).not.toHaveAttribute('hidden');
    expect(within(editor as HTMLElement).getByTestId('mock-craftbook-editor')).toHaveTextContent(
      'battle-report',
    );

    await user.click(screen.getByRole('button', { name: 'Back to craftbooks' }));
    expect(rail).not.toHaveAttribute('hidden');
    expect(editor).toHaveAttribute('hidden');
  });

  it('keeps creation, search, and the list together in the left rail', async () => {
    render(<CraftbooksView />);

    const rail = screen.getByRole('complementary', { name: 'Craftbook library' });
    const search = within(rail).getByRole('searchbox', { name: 'Search craftbooks' });
    const create = within(rail).getByRole('button', { name: '+ New craftbook' });

    expect(search.closest('.craftbooks-toolbar')).toContainElement(create);
    expect(rail.querySelector('.craftbooks-list')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Craftbook editor' })).not.toContainElement(rail);

    await waitFor(() => {
      expect(screen.getByTestId('mock-craftbook-editor')).toHaveTextContent('release-review');
    });
  });

  it('filters the grouped list from the rail search', async () => {
    render(<CraftbooksView />);
    const user = userEvent.setup();

    await screen.findByRole('button', { name: /Historical battle report/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search craftbooks' }), 'battle');

    expect(screen.queryByRole('button', { name: /Release review/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Historical battle report/ })).toBeInTheDocument();
  });
});
