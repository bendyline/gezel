import type { CraftbookSummary } from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

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
    vi.mocked(api.listCraftbooks).mockResolvedValue({ craftbooks: CRAFTBOOKS } as never);
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
